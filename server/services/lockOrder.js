// server/services/lockOrder.js
// Lock-order checker: detects a transaction (MySQL) or engine operation (in-memory) that acquires
// locks against the global order. Two transactions that each follow one total order can never wait
// on each other in a cycle, so following the order rules out lock deadlocks between our own code paths.
//
// The ranks below encode the order the code follows today and that Phase 3 extends. The written
// global lock-order document is produced in Phase 3 step 3, together with the per-hospital lock.
//
//   EmergencyRequest (10) -> Hospital (30) -> Doctor (40) -> MedicalResource (50, by resource_type)
//     -> Ambulance (60)          [+ case-owned rows, valid at any point after EmergencyRequest]
//
// Case-owned tables (HospitalAcceptance, ResourceAllocation) hold rows that belong to one case. They
// may only be locked while the scope already holds an EmergencyRequest lock: the case lock then
// serialises every access to them, so they have no position of their own in the order and do not
// constrain later locks. Locking them without a case lock is a violation.
//
// Rules applied to every other NEW lock while locks are held:
//   1. Its rank must be >= the highest rank currently held (case-owned rows excluded), unless
//   2. the table is already held in this scope (re-locking rows the scope already owns).
//   3. Within one rank, when keys are known (in-memory adapter), keys must ascend.
// Locks that never wait (SELECT ... SKIP LOCKED / NOWAIT) cannot take part in a wait cycle; they are
// recorded as held but never reported. Plain reads take no locks under READ COMMITTED and INSERTs
// lock only rows that did not exist before, so neither is checked.
//
// Limitation (MySQL adapter): it works per table, from the SQL text. It cannot see row keys, so the
// within-table order (for example MedicalResource rows by resource_type) is verified by the
// in-memory adapter and by the concurrent tests, not here.

import { AsyncLocalStorage } from 'node:async_hooks';

export const LOCK_RANKS = Object.freeze({
  EmergencyRequest: 10,
  Hospital: 30,
  Doctor: 40,
  MedicalResource: 50,
  Ambulance: 60
});

export const CASE_ANCHOR_TABLE = 'EmergencyRequest';
export const CASE_OWNED_TABLES = Object.freeze(['HospitalAcceptance', 'ResourceAllocation']);

export class LockOrderChecker {
  constructor({ ranks = LOCK_RANKS, caseOwned = CASE_OWNED_TABLES, anchor = CASE_ANCHOR_TABLE } = {}) {
    this.ranks = ranks;
    this.caseOwned = new Set(caseOwned);
    this.anchor = anchor;
    this.violations = [];
    this.acquisitions = 0;
  }

  /** Start a scope (one transaction / one engine operation). */
  begin(label = 'scope') {
    return { label, held: [] };
  }

  /**
   * Record a lock acquisition in `scope`. Returns the violation (also stored in this.violations) or null.
   * @param {{key?:string|null, noWait?:boolean, source?:string}} options
   */
  acquire(scope, table, { key = null, noWait = false, source = null } = {}) {
    const owned = this.caseOwned.has(table);
    const rank = this.ranks[table];
    if (!owned && rank === undefined) return null; // unranked tables (append-only audit, alerts) are not ordered
    this.acquisitions += 1;
    let violation = null;
    if (owned) {
      if (!scope.held.some(h => h.table === this.anchor)) violation = { kind: 'OWNED', table };
    } else {
      const ranked = scope.held.filter(h => !h.owned);
      if (!noWait && ranked.length) {
        const top = ranked.reduce((a, b) => (b.rank > a.rank || (b.rank === a.rank && compareKeys(b.key, a.key) > 0) ? b : a));
        const holdsTable = ranked.some(h => h.table === table);
        if (rank < top.rank && !holdsTable) {
          violation = { kind: 'RANK', table, rank, after: top.table, afterRank: top.rank };
        } else if (rank === top.rank && key !== null && top.key !== null && compareKeys(key, top.key) < 0
          && !ranked.some(h => h.table === table && h.key === key)) {
          violation = { kind: 'KEY', table, key, after: top.table, afterKey: top.key };
        }
      }
    }
    if (violation) {
      Object.assign(violation, { scope: scope.label, source, held: scope.held.map(h => `${h.table}${h.key === null ? '' : `[${h.key}]`}`) });
      this.violations.push(violation);
    }
    scope.held.push({ table, key, rank: rank ?? null, owned });
    return violation;
  }

  /** Record that one lock was released before the scope ended (in-memory mutexes). */
  release(scope, table, key = null) {
    const index = scope.held.findIndex(h => h.table === table && h.key === key);
    if (index >= 0) scope.held.splice(index, 1);
  }

  /** Human-readable summary of every violation, for assertion messages. */
  describe() {
    return this.violations.map(v => {
      const where = `${v.source ? ` — ${v.source}` : ''}`;
      if (v.kind === 'OWNED') return `[${v.scope}] locked case-owned ${v.table} without holding ${this.anchor}; held: ${v.held.join(', ') || 'nothing'}${where}`;
      if (v.kind === 'RANK') return `[${v.scope}] locked ${v.table} (rank ${v.rank}) after ${v.after} (rank ${v.afterRank}); held: ${v.held.join(', ')}${where}`;
      return `[${v.scope}] locked ${v.table}[${v.key}] after ${v.after}[${v.afterKey}] (keys must ascend); held: ${v.held.join(', ')}${where}`;
    }).join('\n');
  }
}

function compareKeys(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return String(a) < String(b) ? -1 : 1;
}

// ── MySQL adapter: classify the locking statements a transaction issues ─────────────────────────
/**
 * Returns { table, noWait } for a statement that takes row locks on pre-existing rows, or null.
 * Locking reads (FOR UPDATE / FOR SHARE), UPDATE and DELETE count; plain SELECT and INSERT do not.
 */
export function classifyStatement(sql) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  if (/^(SELECT|WITH)\b/i.test(s)) {
    if (!/\bFOR (UPDATE|SHARE)\b/i.test(s)) return null;
    const from = s.match(/\bFROM\s+`?(\w+)`?/i);
    return from ? { table: from[1], noWait: /\b(SKIP LOCKED|NOWAIT)\b/i.test(s) } : null;
  }
  const update = s.match(/^UPDATE\s+`?(\w+)`?/i);
  if (update) return { table: update[1], noWait: false };
  const del = s.match(/^DELETE\s+FROM\s+`?(\w+)`?/i);
  if (del) return { table: del[1], noWait: false };
  return null;
}

/**
 * Wrap a mysql2 pool so every transaction opened through getConnection() is checked against the lock
 * order. Statements run outside an explicit transaction (autocommit) are not checked: their locks end
 * with the statement. Intended for tests and the stress harness; production code uses the raw pool.
 */
export function instrumentMysqlPool(pool, checker) {
  const wrapConnection = conn => {
    let scope = null;
    return new Proxy(conn, {
      get(target, property, receiver) {
        if (property === 'beginTransaction') {
          return async (...args) => {
            const result = await target.beginTransaction(...args);
            scope = checker.begin(`tx#${checker.acquisitions}`);
            return result;
          };
        }
        if (property === 'commit' || property === 'rollback') {
          return async (...args) => {
            scope = null;
            return target[property](...args);
          };
        }
        if (property === 'query' || property === 'execute') {
          return (sql, ...rest) => {
            if (scope) {
              const lock = classifyStatement(typeof sql === 'string' ? sql : sql?.sql);
              if (lock) checker.acquire(scope, lock.table, { noWait: lock.noWait, source: String(sql).replace(/\s+/g, ' ').slice(0, 120) });
            }
            return target[property](sql, ...rest);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  };

  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === 'getConnection') {
        return async (...args) => wrapConnection(await target.getConnection(...args));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

// ── In-memory adapter: scopes follow the async call chain of one engine operation ───────────────
// Everything below is a no-op until a checker is installed (tests / harness only).
const scopes = new AsyncLocalStorage();
let installed = null;

/** Install `checker` for the in-memory backend. Returns a function that uninstalls it. */
export function installMemoryLockOrderChecker(checker) {
  installed = checker;
  return () => {
    if (installed === checker) installed = null;
  };
}

/** True while an in-memory checker is installed (callers keep their original code path otherwise). */
export function memoryLockOrderActive() {
  return installed !== null;
}

/** Run `fn` as one lock scope (one engine operation). Without an installed checker it just calls fn. */
export function runInLockScope(label, fn) {
  if (!installed) return fn();
  return scopes.run(installed.begin(label), fn);
}

/** Note an in-memory lock acquisition in the current scope. */
export function noteLockAcquired(table, key = null) {
  if (!installed) return;
  installed.acquire(scopes.getStore() ?? installed.begin('unscoped'), table, { key });
}

/** Note an in-memory lock release in the current scope. */
export function noteLockReleased(table, key = null) {
  if (!installed) return;
  const scope = scopes.getStore();
  if (scope) installed.release(scope, table, key);
}
