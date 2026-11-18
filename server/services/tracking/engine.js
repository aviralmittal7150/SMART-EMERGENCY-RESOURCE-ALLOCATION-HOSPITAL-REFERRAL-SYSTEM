// server/services/tracking/engine.js
// The server-side, authoritative simulation of ambulance trips (Batch 7, live-tracking demo).
//
//  - ONE interval timer (TRACKING_TICK_MS) advances every moving, unpaused trip along its route by speed x elapsed time
//    (capped at two ticks, so a stall or a restart never makes a unit jump), interpolating between route points.
//  - Every step is persisted through the store (trip row + Ambulance.current_lat/lng/eta_mins, atomically), so
//    GET /tracking/trips/:id always shows the stored state and a restarted server continues from it.
//  - Phase changes go through the trip lifecycle (phases.js) and are audited on the normal hash chain. The ambulance
//    follows through the existing store function (updateAmbulanceStatus): nothing bypasses the lock or allocation engines.
//  - Batch 8: a trip NEVER changes the case's status. Arriving at the hospital is a fact of the trip only; the hospital
//    desk starts treatment (PATCH /emergencies/:id/status). When the case is closed (COMPLETED / CANCELLED) its active
//    trip is closed too (closeCaseTrips), so no trip keeps holding a unit.
//  - Actions and ticks on one trip are serialised in this process; every store write is also optimistic (version), so
//    a concurrent change elsewhere is refused (409) instead of overwritten.
//  - Emits 'update' { trip, update, patient: { accountIds, payload } | null } after every persisted change; the server
//    sends it to the rooms allowed to see it (server.js).

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import { StoreError } from '../../db/storeErrors.js';
import { ON_ROAD_AMBULANCE_STATUSES } from '../lifecycle.js';
import { acceptedHospitalId } from '../patientView.js';
import { round7 } from './geo.js';
import { actionError, etaMinutes, etaSeconds, isActive, isMoving, legsOf, step } from './phases.js';
import { createRouter } from './routing.js';
import { areaProblem } from '../operatingArea.js';
import { staffTripView, trackingUpdate, patientTripView } from './view.js';

export const SYSTEM_ACTOR = Object.freeze({ role: 'SYSTEM', id: 'TRACKING-ENGINE' });
const point = (lat, lng) => [Number(lat), Number(lng)];

export class TrackingEngine extends EventEmitter {
  /** store: the data store; router: createRouter(...); tickMs / timeScale: see config.js. */
  constructor({ store, router = createRouter({ url: null }), tickMs = 1000, timeScale = 1, log = console, now = () => Date.now(), area = null, legSeconds = null }) {
    super();
    this.store = store;
    this.router = router;
    this.tickMs = tickMs;
    this.timeScale = timeScale;
    this.log = log;
    this.now = now;
    this.area = area; // Batch 8 (P-0.1): the operating area; every trip point must lie in it (null: unchecked)
    // Batch 8 (P-0.2/Addendum 2): time compression for development / demo. { min, max } real seconds per leg: a leg that
    // would take less (at speed x time scale) takes `min`, one that would take longer takes `max`, so every leg lasts
    // 30-60 s and the whole trip at most 2 minutes, whatever its length in the city. null: real speed x time scale.
    this.legSeconds = legSeconds;
    this._timer = null;
    this._ticking = false;
    this._queues = new Map();   // trip_id -> tail of its serialised work
    this._lastMove = new Map(); // trip_id -> ms of its last movement step in this process
    this._legs = new Map();     // trip_id -> legsOf(trip) (routes never change)
  }

  // ── Timer ────────────────────────────────────────────────────────────────
  /** Start the single tick timer (idempotent: never two timers). */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.tick(); }, this.tickMs);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Advance every moving trip once. A tick still running when the next is due makes that one a no-op. */
  async tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const trips = await this.store.listMovingTrips();
      for (const trip of trips) {
        try {
          await this._serialised(trip.trip_id, () => this._advance(trip.trip_id));
        } catch (err) {
          this.log.error?.(`[TRACKING] Could not advance ${trip.trip_id}: ${err.message}`);
        }
      }
    } catch (err) {
      this.log.error?.(`[TRACKING] Tick failed: ${err.message}`);
    } finally {
      this._ticking = false;
    }
  }

  /** Run `work` after every earlier piece of work on the same trip (in this process). */
  _serialised(tripId, work) {
    const previous = this._queues.get(tripId) ?? Promise.resolve();
    const run = previous.then(work, work);
    const tail = run.catch(() => {});
    this._queues.set(tripId, tail);
    tail.then(() => { if (this._queues.get(tripId) === tail) this._queues.delete(tripId); });
    return run;
  }

  _legsOf(trip) {
    let legs = this._legs.get(trip.trip_id);
    if (!legs) {
      legs = legsOf(trip);
      this._legs.set(trip.trip_id, legs);
    }
    return legs;
  }

  async _advance(tripId) {
    const trip = await this.store.getTrip(tripId);
    if (!trip || !isActive(trip) || Number(trip.paused) || !isMoving(trip)) {
      this._lastMove.delete(tripId);
      return null;
    }
    // The unit left the case (set AVAILABLE / MAINTENANCE, or the case was closed): the trip stops where it is.
    if (!(await this._unitServes(trip))) return this._halt(trip, 'The ambulance is no longer dispatched to this case.');

    const now = this.now();
    const last = this._lastMove.get(tripId);
    const elapsedMs = last === undefined ? this.tickMs : Math.min(Math.max(0, now - last), 2 * this.tickMs);
    this._lastMove.set(tripId, now);
    const legs = this._legsOf(trip);
    const meters = this._metersPerSecond(trip, legs) * (elapsedMs / 1000);
    const next = step(trip, legs, meters);
    next.eta_seconds = this._eta(next.phase, next.progress, legs, trip);

    const changes = { progress: next.progress, current_lat: next.current_lat, current_lng: next.current_lng, eta_seconds: next.eta_seconds };
    const audit = [];
    if (next.arrived) {
      changes.phase = next.arrived;
      changes[next.arrived === 'ARRIVED_AT_PATIENT' ? 'arrived_patient_at' : 'arrived_hospital_at'] = new Date(now);
      this._lastMove.delete(tripId);
      // Arrival is recorded on the trip only (Batch 8): the case's status is the hospital's to change.
      audit.push(this._audit(trip, 'TRIP_PHASE_CHANGED', trip.phase, next.arrived, SYSTEM_ACTOR));
    }
    let result;
    try {
      result = await this.store.updateTrip(tripId, trip.version, changes, {
        audit, unitPosition: { lat: next.current_lat, lng: next.current_lng, eta_mins: etaMinutes(next.eta_seconds) }
      });
    } catch (err) {
      if (err.code === 'TRIP_CONFLICT') return null; // changed meanwhile (an action elsewhere): the next tick re-reads it
      throw err;
    }
    let updated = result.trip;
    if (!result.unitServes) updated = await this._halt(updated, 'The ambulance is no longer dispatched to this case.');
    else await this._publish(updated);
    return updated;
  }

  /**
   * The case was closed (COMPLETED or CANCELLED; its unit already released by that status change) or the receiving
   * hospital confirmed the patient's arrival (handover): every active trip of the case is completed where it stands,
   * audited as TRIP_CLOSED with the reason. Without this a trip that had
   * arrived (not moving, so never halted) would stay active and keep its unit from any later trip. Returns the ids of
   * the trips it closed.
   */
  async closeCaseTrips(requestId, actor, reason) {
    const closed = [];
    for (const { trip_id: tripId } of await this.store.listTrips({ requestId, activeOnly: true })) {
      const done = await this._serialised(tripId, async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const trip = await this.store.getTrip(tripId);
          if (!trip || !isActive(trip)) return null;
          this._lastMove.delete(tripId);
          try {
            const updated = await this._write(trip, { completed_at: new Date(this.now()), paused: 0, eta_seconds: 0 },
              [this._audit(trip, 'TRIP_CLOSED', trip.phase, 'COMPLETED', actor, { reason })]);
            await this._publish(updated);
            return updated;
          } catch (err) {
            if (err.code !== 'TRIP_CONFLICT') throw err; // written meanwhile by another process: re-read and retry
          }
        }
        throw new StoreError(409, `Trip ${tripId} kept changing; it was not closed.`, 'TRIP_CONFLICT');
      });
      if (done) closed.push(done.trip_id);
    }
    return closed;
  }

  // ── Speed and ETA (with the optional time compression) ───────────────────
  /** Real seconds the current-or-given leg takes: its length at speed x time scale, clamped to legSeconds when set. */
  legDuration(lengthMeters, speedKmh) {
    const plain = lengthMeters / (((speedKmh * 1000) / 3600) * this.timeScale);
    if (!this.legSeconds || lengthMeters < 1) return plain;
    return Math.min(this.legSeconds.max, Math.max(this.legSeconds.min, plain));
  }

  /** Metres per real second on the trip's current leg. */
  _metersPerSecond(trip, legs) {
    const length = trip.phase === 'EN_ROUTE_TO_PATIENT' ? legs.toPatientMeters : legs.toHospitalMeters;
    if (!this.legSeconds) return ((trip.speed_kmh * 1000) / 3600) * this.timeScale;
    const seconds = this.legDuration(length, trip.speed_kmh);
    return seconds > 0 ? length / seconds : Infinity;
  }

  /** eta_seconds: simulated seconds at the trip speed, or, with time compression, the real seconds left (counts down). */
  _eta(phase, progress, legs, trip) {
    if (!this.legSeconds) return etaSeconds(phase, progress, legs, trip.speed_kmh);
    const left = (meters, fraction) => Math.max(0, Math.ceil(this.legDuration(meters, trip.speed_kmh) * fraction));
    switch (phase) {
      case 'DISPATCHED': case 'EN_ROUTE_TO_PATIENT': return left(legs.toPatientMeters, 1 - progress);
      case 'ARRIVED_AT_PATIENT': case 'PATIENT_PICKED_UP': return left(legs.toHospitalMeters, 1);
      case 'EN_ROUTE_TO_HOSPITAL': return left(legs.toHospitalMeters, 1 - progress);
      default: return 0;
    }
  }

  /** Pause a trip whose unit no longer serves its case, and record why. */
  async _halt(trip, reason) {
    this._lastMove.delete(trip.trip_id);
    if (Number(trip.paused)) return trip;
    try {
      const { trip: halted } = await this.store.updateTrip(trip.trip_id, trip.version, { paused: 1 }, {
        audit: [this._audit(trip, 'TRIP_HALTED', trip.phase, trip.phase, SYSTEM_ACTOR, { reason })]
      });
      this.log.warn?.(`[TRACKING] ${trip.trip_id} halted: ${reason}`);
      await this._publish(halted);
      return halted;
    } catch (err) {
      if (err.code === 'TRIP_CONFLICT') return trip;
      throw err;
    }
  }

  async _unitServes(trip) {
    const unit = await this.store.getAmbulance(trip.ambulance_id);
    return Boolean(unit) && unit.assigned_request_id === trip.request_id && ON_ROAD_AMBULANCE_STATUSES.includes(unit.status);
  }

  _audit(trip, eventType, previous, next, actor, metadata = {}) {
    return {
      request_id: trip.request_id, hospital_id: trip.hospital_id, event_type: eventType, previous_state: previous, new_state: next,
      actor_role: actor.role, actor_id: actor.id ?? null,
      metadata: { trip_id: trip.trip_id, ambulance_id: trip.ambulance_id, route_source: trip.route_source, is_demo: Number(trip.is_demo) === 1, ...metadata }
    };
  }

  // ── Publishing ───────────────────────────────────────────────────────────
  async _publish(trip) {
    let patient = null;
    try {
      const ctx = await this.context(trip);
      // Read on every publish (one indexed query): an account linked or unlinked a moment ago is followed at once.
      const accountIds = ctx.request?.patient_id ? await this.store.listPatientAccountIds(ctx.request.patient_id) : [];
      if (accountIds.length) patient = { accountIds, payload: { request_id: trip.request_id, ...patientTripView(trip, ctx) } };
    } catch (err) {
      this.log.error?.(`[TRACKING] Could not build the patient update for ${trip.trip_id}: ${err.message}`);
    }
    this.emit('update', { trip, update: trackingUpdate(trip), patient });
  }

  // ── Views ────────────────────────────────────────────────────────────────
  /** The rows a view needs: the case (pickup), its patient and the destination hospital, read from their own tables. */
  async context(trip) {
    const [request, hospital] = await Promise.all([this.store.getRequest(trip.request_id), this.store.getHospital(trip.hospital_id)]);
    const patient = request?.patient_id ? await this.store.getPatient(request.patient_id) : null;
    return { request, patient, hospital };
  }

  async staffView(trip) {
    return staffTripView(trip, await this.context(trip));
  }

  async patientView(trip) {
    return patientTripView(trip, await this.context(trip));
  }

  // ── Create ───────────────────────────────────────────────────────────────
  /**
   * Create a trip for an ALLOCATED case (statuses: the case statuses accepted, the demo set-up also allows IN_TREATMENT)
   * from (start_lat, start_lng) via the case's pickup point to the hospital that accepted it. The ambulance must
   * already be on the road for this case, or AVAILABLE (then it is dispatched through the normal dispatch path).
   */
  async createTrip({ request_id, ambulance_id, start_lat, start_lng, speed_kmh, is_demo = false }, actor, { statuses = ['ALLOCATED'] } = {}) {
    const detail = await this.store.getRequestDetail(request_id);
    if (!detail) throw new StoreError(404, 'Emergency request not found.');
    const request = detail.request;
    if (request.pickup_lat === null || request.pickup_lat === undefined || request.pickup_lng === null || request.pickup_lng === undefined) {
      throw new StoreError(409, `Case ${request_id} has no pickup coordinates.`);
    }
    if (!statuses.includes(request.status)) {
      throw new StoreError(409, `A trip needs a case accepted by a hospital (${statuses.join(' or ')}); ${request_id} is ${request.status}.`);
    }
    const hospitalId = acceptedHospitalId(detail.acceptances ?? []);
    if (!hospitalId) throw new StoreError(409, `Case ${request_id} has no accepted hospital.`);
    const hospital = await this.store.getHospital(hospitalId);
    const unit = await this.store.getAmbulance(ambulance_id);
    if (!unit) throw new StoreError(404, 'Ambulance not found.');

    const active = [...await this.store.listTrips({ ambulanceId: ambulance_id }), ...await this.store.listTrips({ requestId: request_id })].filter(isActive);
    if (active.some(t => t.ambulance_id === ambulance_id)) throw new StoreError(409, `Ambulance ${ambulance_id} already has an active trip.`);
    if (active.length) throw new StoreError(409, `Case ${request_id} already has an active trip.`);

    const serves = unit.assigned_request_id === request_id && ON_ROAD_AMBULANCE_STATUSES.includes(unit.status);
    if (!serves) {
      if (unit.status !== 'AVAILABLE') {
        throw new StoreError(409, `Ambulance ${ambulance_id} is ${unit.status}${unit.assigned_request_id ? ` for ${unit.assigned_request_id}` : ''} and cannot take ${request_id}.`);
      }
      if (request.assigned_ambulance_id) {
        throw new StoreError(409, `Case ${request_id} already has ambulance ${request.assigned_ambulance_id} on the way; use that unit.`);
      }
    }

    // Batch 8 (P-0.1): validated before routing; nothing is dispatched or routed for a point outside the operating area.
    const outside = this.area && areaProblem([['The trip start', start_lat, start_lng], ['The pickup point', request.pickup_lat, request.pickup_lng],
      ['The destination hospital', hospital?.location_lat, hospital?.location_lng]], this.area);
    if (outside) throw new StoreError(400, outside);
    const start = point(start_lat, start_lng);
    const pickup = point(request.pickup_lat, request.pickup_lng);
    const destination = point(hospital.location_lat, hospital.location_lng);
    const [toPatient, toHospital] = await Promise.all([this.router.route(start, pickup), this.router.route(pickup, destination)]);
    const route_source = toPatient.source === 'osrm' && toHospital.source === 'osrm' ? 'osrm' : 'simulated';

    // Through the normal dispatch path (checks: accepted referral, unit AVAILABLE, no other unit on the case; audited).
    if (!serves) await this.store.updateAmbulanceStatus(ambulance_id, { status: 'DISPATCHED', request_id }, actor);

    const row = {
      trip_id: `TRIP-${uuidv4().slice(0, 8).toUpperCase()}`,
      request_id, ambulance_id, hospital_id: hospitalId,
      start_lat: round7(start[0]), start_lng: round7(start[1]), speed_kmh,
      route_to_patient: toPatient.points, route_to_hospital: toHospital.points, route_source,
      current_lat: toPatient.points[0][0], current_lng: toPatient.points[0][1],
      is_demo: is_demo ? 1 : 0, created_by: actor.id ?? null
    };
    row.eta_seconds = this._eta('DISPATCHED', 0, legsOf(row), row);
    const trip = await this.store.createTrip(row, { audit: [this._audit(row, 'TRIP_CREATED', null, 'DISPATCHED', actor, { speed_kmh })] });
    await this._publish(trip);
    return trip;
  }

  /**
   * Demo trips only (the demo set-up): end an active trip that its crew will not finish, e.g. when its unit is taken for
   * the sample trip. It is marked completed where it stands and audited as TRIP_ABANDONED; the caller frees the unit.
   */
  async abandon(tripId, actor, reason) {
    return this._serialised(tripId, async () => {
      const trip = await this.store.getTrip(tripId);
      if (!trip || !isActive(trip)) return trip;
      if (Number(trip.is_demo) !== 1) throw new StoreError(409, `Trip ${tripId} is not a demo trip and cannot be abandoned.`);
      this._lastMove.delete(tripId);
      const updated = await this._write(trip, { completed_at: new Date(this.now()), paused: 0, eta_seconds: 0 },
        [this._audit(trip, 'TRIP_ABANDONED', trip.phase, 'ABANDONED', actor, { reason })]);
      await this._publish(updated);
      return updated;
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  /** start | pause | resume | pickup | complete | reset. Refusals are StoreErrors (404 / 409). Returns the trip. */
  async act(tripId, action, actor) {
    return this._serialised(tripId, async () => {
      const trip = await this.store.getTrip(tripId);
      if (!trip) throw new StoreError(404, 'Trip not found.');
      const refusal = actionError(trip, action);
      if (refusal) throw new StoreError(409, refusal);
      const updated = await this[`_${action}`](trip, actor);
      await this._publish(updated);
      return updated;
    });
  }

  async _requireUnit(trip, verb) {
    if (!(await this._unitServes(trip))) {
      throw new StoreError(409, `Cannot ${verb}: ambulance ${trip.ambulance_id} is no longer dispatched to ${trip.request_id}.`);
    }
  }

  async _write(trip, changes, audit, unitPosition = null) {
    return (await this.store.updateTrip(trip.trip_id, trip.version, changes, { audit, unitPosition })).trip;
  }

  async _start(trip, actor) {
    await this._requireUnit(trip, 'start');
    const unit = await this.store.getAmbulance(trip.ambulance_id);
    if (unit.status !== 'IN_TRANSIT') await this.store.updateAmbulanceStatus(trip.ambulance_id, { status: 'IN_TRANSIT' }, actor);
    const updated = await this._write(trip, { phase: 'EN_ROUTE_TO_PATIENT', started_at: new Date(this.now()), paused: 0 },
      [this._audit(trip, 'TRIP_PHASE_CHANGED', trip.phase, 'EN_ROUTE_TO_PATIENT', actor)]);
    this._lastMove.set(trip.trip_id, this.now());
    return updated;
  }

  async _pause(trip, actor) {
    this._lastMove.delete(trip.trip_id);
    return this._write(trip, { paused: 1 }, [this._audit(trip, 'TRIP_PAUSED', trip.phase, trip.phase, actor)]);
  }

  async _resume(trip, actor) {
    await this._requireUnit(trip, 'resume');
    const updated = await this._write(trip, { paused: 0 }, [this._audit(trip, 'TRIP_RESUMED', trip.phase, trip.phase, actor)]);
    this._lastMove.set(trip.trip_id, this.now());
    return updated;
  }

  /** ARRIVED_AT_PATIENT -> PATIENT_PICKED_UP -> EN_ROUTE_TO_HOSPITAL (both audited); leg 2 starts at the pickup point. */
  async _pickup(trip, actor) {
    await this._requireUnit(trip, 'pick up');
    const legs = this._legsOf(trip);
    const [lat, lng] = trip.route_to_hospital[0];
    const updated = await this._write(trip, {
      phase: 'EN_ROUTE_TO_HOSPITAL', picked_up_at: new Date(this.now()), progress: 0, current_lat: lat, current_lng: lng,
      eta_seconds: this._eta('EN_ROUTE_TO_HOSPITAL', 0, legs, trip), paused: 0
    }, [
      this._audit(trip, 'TRIP_PHASE_CHANGED', 'ARRIVED_AT_PATIENT', 'PATIENT_PICKED_UP', actor),
      this._audit(trip, 'TRIP_PHASE_CHANGED', 'PATIENT_PICKED_UP', 'EN_ROUTE_TO_HOSPITAL', actor)
    ], { lat, lng, eta_mins: etaMinutes(this._eta('EN_ROUTE_TO_HOSPITAL', 0, legs, trip)) });
    this._lastMove.set(trip.trip_id, this.now());
    return updated;
  }

  /**
   * The crew ends the trip at the hospital. Batch 8 (P-0.2): the unit is NOT released here; it stays on the case (it
   * keeps its last position, the hospital) until the receiving hospital confirms the arrival (handover,
   * POST /emergencies/:id/arrive), or the case is closed. Only then does it become AVAILABLE.
   */
  async _complete(trip, actor) {
    return this._write(trip, { completed_at: new Date(this.now()), eta_seconds: 0 },
      [this._audit(trip, 'TRIP_COMPLETED', trip.phase, 'COMPLETED', actor)]);
  }

  /**
   * Demo trips only: back to DISPATCHED at the start position, progress 0, timestamps cleared. The unit is put back on
   * the case as DISPATCHED through the normal dispatch path (re-dispatched if it was released). The case's own status
   * is never touched by a trip.
   */
  async _reset(trip, actor) {
    // A completed trip becomes active again: refuse BEFORE touching the unit if its unit or its case already has another
    // active trip, so a refused reset has no side effects (the store re-checks this atomically on the write).
    if (trip.completed_at) {
      const others = [...await this.store.listTrips({ ambulanceId: trip.ambulance_id, activeOnly: true }),
        ...await this.store.listTrips({ requestId: trip.request_id, activeOnly: true })].filter(t => t.trip_id !== trip.trip_id);
      if (others.length) {
        throw new StoreError(409, `Cannot reset: ${others[0].ambulance_id === trip.ambulance_id ? `ambulance ${trip.ambulance_id}` : `case ${trip.request_id}`} already has another active trip (${others[0].trip_id}).`);
      }
    }
    let unit = await this.store.getAmbulance(trip.ambulance_id);
    const serves = unit.assigned_request_id === trip.request_id && ON_ROAD_AMBULANCE_STATUSES.includes(unit.status);
    if (serves && unit.status === 'IN_TRANSIT') {
      // DISPATCHED again: through station (AVAILABLE) and dispatch, the only path the existing status rules allow.
      await this.store.updateAmbulanceStatus(trip.ambulance_id, { status: 'AVAILABLE' }, actor);
      unit = await this.store.getAmbulance(trip.ambulance_id);
    }
    if (!serves || unit.status === 'AVAILABLE') {
      if (unit.status !== 'AVAILABLE') {
        throw new StoreError(409, `Cannot reset: ambulance ${trip.ambulance_id} is ${unit.status}${unit.assigned_request_id ? ` for ${unit.assigned_request_id}` : ''}.`);
      }
      await this.store.updateAmbulanceStatus(trip.ambulance_id, { status: 'DISPATCHED', request_id: trip.request_id }, actor);
    }
    const legs = this._legsOf(trip);
    const [lat, lng] = trip.route_to_patient[0];
    const eta = this._eta('DISPATCHED', 0, legs, trip);
    this._lastMove.delete(trip.trip_id);
    return this._write(trip, {
      phase: 'DISPATCHED', progress: 0, current_lat: lat, current_lng: lng, eta_seconds: eta, paused: 0,
      started_at: null, arrived_patient_at: null, picked_up_at: null, arrived_hospital_at: null, completed_at: null
    }, [this._audit(trip, 'TRIP_RESET', trip.completed_at ? 'COMPLETED' : trip.phase, 'DISPATCHED', actor)], { lat, lng, eta_mins: etaMinutes(eta) });
  }
}
