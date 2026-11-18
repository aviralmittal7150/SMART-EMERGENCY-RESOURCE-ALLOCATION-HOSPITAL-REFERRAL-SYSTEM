# Staged claims and the Banker's safety check

Phase 3 Step 4 (Banker's option A; decisions D2-B, D4-A, D5-A). This describes the code as implemented:
`server/services/bankers.js` (the algorithm), `server/services/clinicalPathways.js` (claims),
`server/services/hospitalSafety.js` (one hospital's state), and both locking engines.

## Why

Before Step 4 a case received everything it would ever need at once, so after admission it never waited for
more: no hold-and-wait, and the Banker's check would only repeat the availability check. Real surgical care is
staged. A trauma patient needs an operating theatre and a surgeon first, and an ICU bed afterwards. Admitting
surgical cases whose post-operative bed can never become available means patients hold a theatre while waiting
for a bed that will not come. The Banker's check prevents admitting a case unless every admitted case can still
finish in some order.

## Claims (fixed at intake)

| Type | Stage 1 (allocated on accept) | Stage 2 (allocated by an explicit stage advance) |
| :--- | :--- | :--- |
| TRAUMA | OT + trauma surgeon (+ operator extras) | ICU bed |
| POLYTRAUMA | OT + trauma surgeon (+ operator extras) | ICU bed + ventilator |
| All other types | today's preset (+ extras) | — |

The splits are engineering assumptions, not clinical facts (D2-a1). They live in one validated module that the
server checks at start-up (D2-a11). Cases without a recorded claim (created before claims existed) are legacy
single-stage cases: their maximum is exactly what they hold.

## The state of one hospital

Per resource type (`ICU_BED`, `OT`, `VENTILATOR`, `TRAUMA_SURGEON`):

- **Available**: free units (`available_capacity − locked_capacity`) and AVAILABLE trauma surgeons. Occupancy
  no case owns is never released, so it counts as neither available nor held (G4).
- **Allocation** (per case): soft-locked and committed units at this hospital, plus its reserved or assigned surgeon.
- **Max** (per case): the peak requirement over its **remaining** stages (D2-a8).
- **Need** = Max − Allocation.

## The algorithm

**Safety:** set `Work = Available`. Repeatedly pick a case whose `Need ≤ Work` (the earliest in a fixed order),
assume it finishes, and set `Work += Allocation`. The state is SAFE if every case can be picked. The completion
order is returned (`sequence`). If the state is unsafe, the cases that can never finish and their shortfall are
returned instead (`unfinished`).

**Request** (admission at stage 1, or a stage advance): refuse if the request exceeds the case's Need
(`EXCEEDS_CLAIM`) or what is free now (`INSUFFICIENT`). Otherwise apply it tentatively and refuse if the result is
not SAFE (`UNSAFE`). A hospital that is already unsafe admits and advances nobody (`HOSPITAL_UNSAFE`, D5-a3).

Every refusal carries an explanation: the blocking type, the need and what is obtainable. It reaches the API as
`safety` in the 409 response and is written to the case's audit trail (`ADMISSION_REFUSED_UNSAFE`,
`STAGE_ADVANCE_REFUSED`).

## Where it runs

Under the per-hospital lock, after every row lock is taken and before anything is written. A refusal therefore
leaves nothing behind: MySQL throws before its first write and rolls back; the in-memory engine decides in its
synchronous section and applies only on success (G9). Every writer of a hospital's resources, allocations,
assignments and doctors holds the same lock, so the state the check reads is consistent.

| Event | Effect |
| :--- | :--- |
| Referral (soft-lock) | admission check for the claim's current stage |
| Accept | none (the units were already counted when soft-locked) |
| Stage advance | releases what the next stage no longer needs (OT, surgeon → AVAILABLE), checks, then allocates the next stage with `stage_no` = the new stage |
| Reject / expiry / cancel / complete | releases; re-evaluates a hospital flagged UNSAFE |
| Failover | skips hospitals that refuse as unsafe; if none admits the case: `ADMISSION_ESCALATED` audit event plus a SYSTEM alert (D4-a3/a4) |
| Capacity edit | allowed even if it makes the hospital unsafe (D5-A): `UNSAFE_STATE` audit event plus an alert, `/hospitals/:id/safety` reports unsafe, `SAFE_STATE_RESTORED` once releases or capacity restore safety |

## What it guarantees, and what it does not

- **Guarantee:** if every case's declared claim is honest and every case eventually completes or is cancelled,
  the cases the system admitted can always finish in some order, so none is stuck holding a theatre while
  waiting for a bed that can never become free.
- **Not covered:** capacity removed from outside (a capacity edit). That is detected, flagged and alerted, not
  prevented (D5-A). Claims cannot be amended (D2-a4).
- **With the approved pathways**, stage-1 holdings are the theatre, the surgeon and optional extras, and stage-2
  needs are ICU beds and ventilators. A strict circular wait between claimed cases therefore cannot form.
  Unsafe states arise when the ICU beds or ventilators that will ever become obtainable cannot cover the
  remaining stages (occupancy no case owns, or a capacity edit). The checks are conservative: they can refuse
  a referral at a hospital that has a theatre free right now (D4 clinical risk, measured by the harness as the
  P1 refusal rate).

## Endpoints

- `POST /api/v1/emergencies`: the response includes `claim` and `current_stage`.
- `POST /api/v1/referrals/initiate`: a 409 includes `safety` (reason, blocking type, request, explanation).
- `POST /api/v1/emergencies/:id/advance-stage`: ADMIN, or the desk of the hospital holding the case.
- `GET /api/v1/hospitals/:id/safety`: ADMIN, or that hospital's desk. Returns each case's allocation, max and
  need, the completion order or the unfinished cases, and the hospital's `safety_state` flag.
