# Audit hash chain

Phase 3 Step 5 (approved direction AC). Code: `server/services/auditChain.js` (pure), the MySQL engine's
`_audit` / `_flushAudits` / `verifyAuditChain`, the in-memory `db.auditLog`, migration 006, `GET /api/v1/audit/verify`.

## What a record covers

Each audit row has `chain_seq` (1, 2, 3 … in commit order), `prev_hash` (the previous row's `row_hash`; 64 zeros
for the first) and

    row_hash = SHA-256( canonical JSON of { chain_seq, prev_hash, event_time_ms, request_id, hospital_id,
                                            event_type, previous_state, new_state, actor_role, actor_id, metadata } )

Canonical JSON sorts object keys at every level, keeps array order, drops `undefined` and has no whitespace, so the
hash can be recomputed from the stored row on any machine. `event_time_ms` is the exact millisecond hashed;
MySQL derives `event_time` from it on the server, so client/server time zones cannot change the hash.

## How it is written (both backends)

| Requirement | MySQL | In-memory |
| :--- | :--- | :--- |
| Same transaction (AC1) | rows are buffered during the transaction and written as its last step | appended synchronously at the commit point |
| Head lock until commit (AC2) | `AuditChainHead` `FOR UPDATE`, the last lock (rank 90), held until `COMMIT`: chain order = commit order | single thread: appends are totally ordered |
| Deadlock retry rebuilds (AC4) | each attempt starts with an empty buffer; nothing of a failed attempt is written | n/a |
| Rollback leaves no gap (AC5) | the rows and the head move roll back together | nothing is appended before the commit point |

## Verification (AC8, AC10)

`GET /api/v1/audit/verify` (ADMIN) recomputes the whole chain. MySQL reads rows and head in one consistent
snapshot. It checks sequence continuity from 1, every `prev_hash` link, every `row_hash`, that the displayed
`event_time` equals the hashed `event_time_ms`, that storage order rises with `chain_seq`, that the stored head
matches the last row, and that no unchained row was stored after the first chained one. It reports `valid`, the
first break (`chain_seq` and reason: `SEQUENCE_GAP`, `SEQUENCE_DUPLICATE`, `PREV_HASH_MISMATCH`, `ROW_HASH_MISMATCH`,
`EVENT_TIME_MISMATCH`, `ORDER_MISMATCH`, `HEAD_MISMATCH`, or `UNCHAINED_ROW` with `chain_seq: null`), the head
`{ chain_seq, hash }` for a future external checkpoint, `legacy_unchained` (legacy rows: written before migration 006,
they carry no hash) and `unchained_after_chain` (any other row without a `chain_seq`). A break inside the chain is
reported before an `UNCHAINED_ROW`.

- **`event_time`** (shown and sorted on) is not part of the hash; `event_time_ms` is. Both stores write `event_time`
  from the hashed millisecond (MySQL: `FROM_UNIXTIME(event_time_ms / 1000)` on a UTC session into `TIMESTAMP(3)`;
  memory: its ISO string), and verification compares them: MySQL `ROUND(UNIX_TIMESTAMP(event_time) * 1000)`, memory
  `Date.parse(event_time)`. An edited displayed time is `EVENT_TIME_MISMATCH`.
- **Unchained rows, MySQL:** the legacy set is recorded once, by migration 007, in `AuditChainHead`:
  `legacy_max_history_id` (highest `history_id` of the rows that were unchained and stored before the first chained row
  when 007 ran) and `legacy_count` (how many). Verification reports `UNCHAINED_ROW` with the row's `history_id` for any
  unchained row above `legacy_max_history_id`, and `UNCHAINED_ROW` with `history_id: null`, `legacy_recorded` and
  `legacy_found` when the number of unchained rows at or below it differs from `legacy_count`: a row inserted with an
  explicit `history_id` into a gap among the legacy ids, or a deleted legacy row (that row cannot be named). Deriving
  "legacy" from the first chained row instead would accept a row slipped into an id gap below it. A fresh database
  records none (`legacy_count` 0, `legacy_max_history_id` NULL), so every unchained row is a break there.
- **Unchained rows, in memory:** the demo store has no recorded mark and needs none: rows are only ever appended, so
  an unchained row before the first chained row (array position) is legacy and any after it is `UNCHAINED_ROW`.
- **Field types:** every audit writer (`_audit` on MySQL, `db.auditLog` in memory) accepts only a string, a finite
  number (stored and hashed as its string form) or null for `request_id`, `hospital_id`, `event_type`,
  `previous_state`, `new_state`, `actor_role` and `actor_id`, and only a plain object or null for `metadata`. Anything
  else is refused before it is written, because it would hash differently from what MySQL stores.

## What it guarantees, and what it does not

- **Detects:** a changed field in any chained row, a changed `prev_hash` or `chain_seq`, a deleted or duplicated
  row in the middle, reordered rows, and (MySQL) a cut-off tail while the head row is intact.
- **Does not detect:** a cut-off tail together with the head, or a full recomputation of the chain by someone with
  database write access. Closing that gap needs the head kept outside the database (a signed or external
  checkpoint); verification already returns it, but no external anchoring exists (AC10: no cloud, no cost).
- **No secret key.** The hash is plain SHA-256 over public fields: nothing secret goes into it. So anyone who holds
  the application's own database credentials (or any account that may INSERT into `EmergencyHistory` and UPDATE
  `AuditChainHead`) can append forged rows with correctly computed hashes and advance the head, and verification will
  report a valid chain. The chain only shows edits made *without* recomputing it. Detecting forged appends needs
  something the database does not hold: an external checkpoint of the head, or an HMAC keyed with a secret kept out
  of the application's database account. Neither is built.
- **Tamper-evident, not tamper-proof.** Nothing stops an edit; verification shows it afterwards. MySQL triggers
  could refuse UPDATE/DELETE, but creating them needs SUPER while binary logging is on, which the application
  account must not have. Append-only should be enforced by giving the application account no UPDATE or DELETE on
  `EmergencyHistory`.
- **In-memory demo store:** its head is its last row, so a cut tail is not detectable there.
- **Rejected audit entry, in memory (known divergence):** entry validation runs inside `db.auditLog`, which the
  in-memory store calls after it has already changed its arrays. An invalid entry would therefore throw with the change
  applied and no audit row for it. On MySQL the same error rolls the whole transaction back, so neither is written.
  Every current call site passes valid fields (all checked; the contract suite runs them on both stores), so this is
  latent, not observed.
- **Deleting a case** (no API does) sets `EmergencyHistory.request_id` to NULL through the foreign key, which the
  chain then reports as tampering.
- **Cost:** every audit-writing transaction briefly holds one lock shared by all hospitals. The stress harness
  measures it (AC9): rows written and per-transaction write latency including the wait for the head.
