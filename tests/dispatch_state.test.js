// Tests for the roadside "Dispatch EMS" logic (js/dispatch_state.js).
// Unit tests cover the decision/orchestration rules with injected fakes; the contract test
// drives the real accept / list / dispatch routes so the helper is checked against the
// actual response shapes. All patient data is fictional. No browser is involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { db } from '../server/db/seed.js';
import { generateToken } from '../server/middleware/auth.js';
import emergenciesRoutes from '../server/routes/emergencies.js';
import referralsRoutes from '../server/routes/referrals.js';
import ambulancesRoutes from '../server/routes/ambulances.js';
import {
  findAssignedAmbulance,
  getDispatchControl,
  dispatchForReferral
} from '../js/dispatch_state.js';

const referral = { requestId: 'REQ-1', hospitalId: 'H-101' };
const amb = (id, extra = {}) => ({ id, status: 'AVAILABLE', type: 'ALS', etaMins: 4, ...extra });

// ── Decision rules ───────────────────────────────────────────────────────────
test('control: a case with an assigned ambulance shows its id/status and disables dispatch', () => {
  const control = getDispatchControl({
    referral,
    ambulances: [amb('AMB-01', { status: 'DISPATCHED', assigned_request_id: 'REQ-1', etaMins: 4 }), amb('AMB-03')],
    inFlight: new Set()
  });
  assert.equal(control.state, 'ASSIGNED');
  assert.equal(control.disabled, true);
  assert.match(control.label, /AMB-01/);
  assert.match(control.detail, /AMB-01.*DISPATCHED.*ETA 4 min/);
});

test('control: the accept response ambulance_id bridges the gap before the refresh lands', () => {
  const stale = [amb('AMB-01', { status: 'DISPATCHED' }), amb('AMB-03')];
  const control = getDispatchControl({ referral: { ...referral, ambulanceId: 'AMB-01' }, ambulances: stale, inFlight: new Set() });
  assert.equal(control.state, 'ASSIGNED');
  assert.equal(control.ambulance.id, 'AMB-01');
});

test('control: a released (AVAILABLE) unit from an earlier assignment is not treated as assigned', () => {
  const control = getDispatchControl({ referral: { ...referral, ambulanceId: 'AMB-01' }, ambulances: [amb('AMB-01')], inFlight: new Set() });
  assert.equal(control.state, 'DISPATCHABLE');
  assert.equal(control.disabled, false);
});

test('control: the accepted unit that has since gone to MAINTENANCE is not shown as assigned, and dispatch stays open', () => {
  // The accept response named AMB-01; it broke down (MAINTENANCE clears its assignment on the server).
  const ambulances = [amb('AMB-01', { status: 'MAINTENANCE' }), amb('AMB-03')];
  const control = getDispatchControl({ referral: { ...referral, ambulanceId: 'AMB-01' }, ambulances, inFlight: new Set() });
  assert.equal(control.state, 'DISPATCHABLE', 'an out-of-service unit must not be presented as the transport');
  assert.equal(control.disabled, false);
  assert.equal(findAssignedAmbulance(ambulances, { ...referral, ambulanceId: 'AMB-01' }), null);
});

test('control: an assigned_request_id on an out-of-service unit (data from older versions) does not count as transport', () => {
  const ambulances = [amb('AMB-01', { status: 'MAINTENANCE', assigned_request_id: 'REQ-1' }), amb('AMB-03')];
  assert.equal(getDispatchControl({ referral, ambulances, inFlight: new Set() }).state, 'DISPATCHABLE');
});

test('control: an accepted case with no assigned ambulance keeps dispatch available', () => {
  const control = getDispatchControl({ referral, ambulances: [amb('AMB-03')], inFlight: new Set() });
  assert.equal(control.state, 'DISPATCHABLE');
  assert.equal(control.disabled, false);
  assert.equal(control.label, null, 'the default label is kept');
});

test('control: units assigned to a different case do not count for this one', () => {
  const control = getDispatchControl({
    referral,
    ambulances: [amb('AMB-01', { status: 'DISPATCHED', assigned_request_id: 'REQ-OTHER' }), amb('AMB-03')],
    inFlight: new Set()
  });
  assert.equal(control.state, 'DISPATCHABLE');
});

test('control: pre-acceptance states keep the original click-and-explain behaviour', () => {
  assert.equal(getDispatchControl({ referral: null, ambulances: [], inFlight: new Set() }).state, 'NO_ACCEPTED_REFERRAL');
  assert.equal(getDispatchControl({ referral: null, awaitingAcceptance: true, ambulances: [], inFlight: new Set() }).state, 'AWAITING_ACCEPTANCE');
});

test('control: disabled while a dispatch for the case is in flight', () => {
  const control = getDispatchControl({ referral, ambulances: [amb('AMB-03')], inFlight: new Set(['REQ-1']) });
  assert.equal(control.state, 'IN_FLIGHT');
  assert.equal(control.disabled, true);
});

// ── Click orchestration ──────────────────────────────────────────────────────
function harness(initial, { dispatchImpl, afterRefresh } = {}) {
  let list = initial;
  const calls = { dispatch: [], refresh: 0 };
  return {
    calls,
    inFlight: new Set(),
    getAmbulances: () => list,
    dispatch: async ambulance => { calls.dispatch.push(ambulance.id); if (dispatchImpl) await dispatchImpl(ambulance); },
    refresh: async () => { calls.refresh += 1; if (afterRefresh) list = afterRefresh(list); }
  };
}

test('click: an already-assigned case sends no second dispatch request', async () => {
  const h = harness([amb('AMB-01', { status: 'DISPATCHED', assigned_request_id: 'REQ-1' }), amb('AMB-03')]);
  const result = await dispatchForReferral({ referral, ...h });
  assert.equal(result.outcome, 'ALREADY_ASSIGNED');
  assert.equal(result.ambulance.id, 'AMB-01');
  assert.deepEqual(h.calls.dispatch, []);
});

test('click: a case without an assigned ambulance dispatches exactly one available unit', async () => {
  const h = harness([amb('AMB-02', { status: 'IN_TRANSIT' }), amb('AMB-03'), amb('AMB-04')], {
    afterRefresh: list => list.map(a => a.id === 'AMB-03' ? { ...a, status: 'DISPATCHED', assigned_request_id: 'REQ-1' } : a)
  });
  const result = await dispatchForReferral({ referral, ...h });
  assert.equal(result.outcome, 'DISPATCHED');
  assert.deepEqual(h.calls.dispatch, ['AMB-03']);
  assert.equal(h.calls.refresh, 1);
  assert.equal(result.ambulance.id, 'AMB-03');
  assert.equal(h.inFlight.size, 0);
});

test('click: concurrent clicks send a single dispatch request', async () => {
  // The dispatch call stays pending briefly; a timer (not the second click) releases it,
  // so a missing guard shows up as a failed assertion rather than a hang.
  const h = harness([amb('AMB-03')], { dispatchImpl: () => new Promise(resolve => setTimeout(resolve, 30)) });
  const [first, second] = await Promise.all([
    dispatchForReferral({ referral, ...h }),
    dispatchForReferral({ referral, ...h })
  ]);
  assert.deepEqual([first.outcome, second.outcome], ['DISPATCHED', 'IN_FLIGHT']);
  assert.deepEqual(h.calls.dispatch, ['AMB-03']);
});

test('click: an HTTP 409 is recovered by refreshing and showing the existing assignment', async () => {
  const h = harness([amb('AMB-03')], {
    dispatchImpl: async () => { throw new Error('Request REQ-1 already has ambulance AMB-01 assigned.'); },
    afterRefresh: () => [amb('AMB-01', { status: 'DISPATCHED', assigned_request_id: 'REQ-1' }), amb('AMB-03')]
  });
  const result = await dispatchForReferral({ referral, ...h });
  assert.equal(result.outcome, 'ALREADY_ASSIGNED');
  assert.equal(result.recovered, true);
  assert.equal(result.ambulance.id, 'AMB-01');
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.inFlight.size, 0);
});

test('click: a genuine failure is still reported, and a retry is possible afterwards', async () => {
  let fail = true;
  const h = harness([amb('AMB-03')], { dispatchImpl: async () => { if (fail) throw new Error('boom'); } });
  const failed = await dispatchForReferral({ referral, ...h });
  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.error.message, 'boom');
  assert.equal(h.inFlight.size, 0, 'the guard is released after a failure');

  fail = false;
  assert.equal((await dispatchForReferral({ referral, ...h })).outcome, 'DISPATCHED');
});

test('click: pre-acceptance, no-referral and no-ambulance cases never call dispatch', async () => {
  const h = harness([amb('AMB-05', { status: 'MAINTENANCE' })]);
  assert.equal((await dispatchForReferral({ referral, awaitingAcceptance: true, ...h })).outcome, 'AWAITING_ACCEPTANCE');
  assert.equal((await dispatchForReferral({ referral: null, ...h })).outcome, 'NO_ACCEPTED_REFERRAL');
  assert.equal((await dispatchForReferral({ referral, ...h })).outcome, 'NO_AMBULANCE');
  assert.deepEqual(h.calls.dispatch, []);
});

// ── Contract with the real backend routes ────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/v1/emergencies', emergenciesRoutes);
app.use('/api/v1/referrals', referralsRoutes);
app.use('/api/v1/ambulances', ambulancesRoutes);

let server;
let base;
test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

// The seeded fleet is tiny and shared across tests in this file, so restore it after each one.
const seededFleet = db.ambulances.map(a => ({ ...a }));
test.afterEach(() => {
  seededFleet.forEach(original => {
    const live = db.ambulances.find(a => a.ambulance_id === original.ambulance_id);
    Object.keys(live).forEach(key => delete live[key]);
    Object.assign(live, original);
  });
});

const tokens = {
  paramedic: generateToken({ user_id: 'U-EMS', role: 'PARAMEDIC', hospital_id: null }),
  desk101: generateToken({ user_id: 'U-H101', role: 'HOSPITAL_DESK', hospital_id: 'H-101' })
};

async function call(path, token, method = 'GET', body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body && JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

// Mirrors normalizeAmbulance() in js/app.js (it spreads the API object, so raw fields survive).
const normalize = item => ({ ...item, id: item.ambulance_id, type: item.ambulance_type, etaMins: item.eta_mins ?? 0 });
const loadAmbulances = async () => (await call('/api/v1/ambulances', tokens.paramedic)).body.ambulances.map(normalize);

async function acceptCase() {
  const created = await call('/api/v1/emergencies', tokens.paramedic, 'POST', {
    patient_name: 'Fictional Dispatch Patient', age: 52, emergency_type: 'CARDIAC', triage_priority: 1
  });
  const requestId = created.body.request_id;
  const initiated = await call('/api/v1/referrals/initiate', tokens.paramedic, 'POST', { request_id: requestId, hospital_id: 'H-101' });
  assert.equal(initiated.status, 201);
  const accepted = await call(`/api/v1/referrals/${initiated.body.acceptance_id}/accept`, tokens.desk101, 'POST');
  assert.equal(accepted.status, 200);
  return { requestId, accepted: accepted.body };
}

test('contract: after accept the UI sees the auto-assigned ambulance and sends no second dispatch', async () => {
  const { requestId, accepted } = await acceptCase();
  assert.ok(accepted.ambulance_id, 'accept response must carry ambulance_id');

  const ambulances = await loadAmbulances();
  const acceptedReferral = { requestId, hospitalId: accepted.hospitalId, ambulanceId: accepted.ambulance_id };
  const assigned = findAssignedAmbulance(ambulances, acceptedReferral);
  assert.equal(assigned.id, accepted.ambulance_id);
  assert.equal(assigned.assigned_request_id, requestId);
  const control = getDispatchControl({ referral: acceptedReferral, ambulances, inFlight: new Set() });
  assert.equal(control.state, 'ASSIGNED');
  assert.equal(control.disabled, true);

  let dispatchRequests = 0;
  const result = await dispatchForReferral({
    referral: acceptedReferral,
    getAmbulances: () => ambulances,
    dispatch: async () => { dispatchRequests += 1; },
    refresh: async () => {}
  });
  assert.equal(result.outcome, 'ALREADY_ASSIGNED');
  assert.equal(dispatchRequests, 0);
});

test('contract: the old double-dispatch really is a 409 from the backend, and the UI now recovers from it', async () => {
  const { requestId, accepted } = await acceptCase();

  // Direct proof of the confirmed bug: a second unit for the same case is refused.
  const spare = (await loadAmbulances()).find(a => a.status === 'AVAILABLE');
  const direct = await call(`/api/v1/ambulances/${spare.id}/status`, tokens.paramedic, 'PATCH', { status: 'DISPATCHED', request_id: requestId });
  assert.equal(direct.status, 409);
  assert.equal(spare.status, 'AVAILABLE');

  // A UI whose list does not yet show the assignment (it still sees the spare unit as free).
  let visible = (await loadAmbulances()).map(a => ({ ...a, assigned_request_id: undefined }));
  let dispatchRequests = 0;
  const result = await dispatchForReferral({
    referral: { requestId, hospitalId: 'H-101' },
    getAmbulances: () => visible,
    dispatch: async candidate => {
      dispatchRequests += 1;
      const response = await call(`/api/v1/ambulances/${candidate.id}/status`, tokens.paramedic, 'PATCH', { status: 'DISPATCHED', request_id: requestId });
      if (response.status >= 400) throw new Error(response.body.error);
    },
    refresh: async () => { visible = await loadAmbulances(); }
  });

  assert.equal(dispatchRequests, 1, 'one attempt, which the backend refuses');
  assert.equal(result.outcome, 'ALREADY_ASSIGNED');
  assert.equal(result.recovered, true);
  assert.equal(result.ambulance.id, accepted.ambulance_id, 'the UI shows the unit the backend assigned');
});

test('contract: with no unit free at accept time the case keeps dispatch, and a later dispatch succeeds', async () => {
  {
    db.ambulances.forEach(a => { a.status = 'MAINTENANCE'; });
    const { requestId, accepted } = await acceptCase();
    assert.equal(accepted.ambulance_id, null, 'nothing to auto-dispatch');

    let ambulances = await loadAmbulances();
    const acceptedReferral = { requestId, hospitalId: 'H-101', ambulanceId: accepted.ambulance_id };
    assert.equal(getDispatchControl({ referral: acceptedReferral, ambulances, inFlight: new Set() }).state, 'DISPATCHABLE');

    // A unit comes back into service (released through the API, which also clears any assignment).
    const released = await call('/api/v1/ambulances/AMB-03/status', tokens.paramedic, 'PATCH', { status: 'AVAILABLE' });
    assert.equal(released.status, 200);
    ambulances = await loadAmbulances();
    let requests = 0;
    const result = await dispatchForReferral({
      referral: acceptedReferral,
      getAmbulances: () => ambulances,
      dispatch: async candidate => {
        requests += 1;
        const response = await call(`/api/v1/ambulances/${candidate.id}/status`, tokens.paramedic, 'PATCH', { status: 'DISPATCHED', request_id: requestId });
        assert.equal(response.status, 200);
      },
      refresh: async () => { ambulances = await loadAmbulances(); }
    });
    assert.equal(result.outcome, 'DISPATCHED');
    assert.equal(requests, 1);
    assert.equal(result.ambulance.assigned_request_id, requestId);
    assert.equal(getDispatchControl({ referral: acceptedReferral, ambulances, inFlight: new Set() }).state, 'ASSIGNED');
  }
});
