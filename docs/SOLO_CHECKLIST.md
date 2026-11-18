# ERIS — solo-developer checklist

Owner and sole decision-maker: **Aviral Mittal**. There are no teammate reviewers or task owners (decided 2026-11-10).

Every change goes through four separate gates. One gate never stands in for another:

1. **Implementation**: the implementing agent writes the code and tests.
2. **Independent review**: a separate AI reviewer agent reads the code, not the implementer's conclusions, and reports findings with evidence. The implementing agent is never the only reviewer of its own change. Fixes for critical or high findings are re-reviewed by a fresh reviewer.
3. **Testing**: suites actually run, with results recorded honestly, including skips. MySQL runs only against `*_test` databases. Each step also runs on Linux CI-equivalent containers (Node 20 and 22, MySQL 8.4), and mutation checks prove the tests catch defects.
4. **Owner approval**: Aviral's explicit approval. Commits, pushes, PRs, merges and deployments each need their own separate approval.

Legend: ✅ done · 🔄 in progress · ⏳ not started / waiting · — not applicable

## Worktrees

| Tree | Role | State |
|---|---|---|
| `~/Downloads/ERIS-integration` (branch `feat/eris-integration`, local) | **active**: full app, frontend + backend | Phase 3 Step 6 work plus the UI redesign, uncommitted; baseline digest `8bf49727…`, 401/401 tests |
| `~/Downloads/ERIS-phase3-backend` | frozen record of backend Steps 3–6 | Step 6 digest `e7c43f93…`; Step 5 snapshot `6cb6c7c8…` kept in the session scratchpad |
| `~/Downloads/SMART EMERGENCY RESOURCE ALLOCATION & HOSPITAL REFERRAL SYSTEM` | original tree holding the UI redesign | never modified (19 uncommitted entries) |
| `~/Downloads/ERIS-audit-ledger-fix` | PR #41, separate work | never overwritten |

## Phase 1: backend (Phase 3 Steps 1–6)

| Step | Implementation | Independent review | Testing | Owner approval |
|---|---|---|---|---|
| 1 Foundations (migration runner, contract suite, fixes) | ✅ committed (`35607c3`, PR #39) | 🔄 review round 1 | ✅ | ⏳ merge |
| 2 Stress harness + baselines | ✅ committed locally (`73f0398`) | 🔄 round 1 | ✅ | ⏳ publish |
| 3 Hospital lock + exclusive trauma surgeon | ✅ uncommitted | 🔄 round 1 (locking) | ✅ macOS + Linux | ⏳ · benchmark ⏳ |
| 4 Staged claims + Banker's algorithm | ✅ uncommitted | 🔄 round 1 (locking) | ✅ macOS + Linux | ⏳ · benchmark comparison ⏳ |
| 5 Audit hash chain | ✅ uncommitted | 🔄 round 1 (audit / migrations) | ✅ macOS + Linux, 16/16 mutants | ✅ functional verification (2026-11-09) · code review ⏳ |
| 6 Analytics + forecast | ✅ uncommitted | 🔄 round 1 (stores / analytics) | ✅ 401/401 macOS + Linux, 16/16 mutants | ⏳ (decisions below) |

Review round 1 runs four independent reviewers: (a) locking, concurrency and Banker's; (b) audit chain, schema and migrations; (c) store parity and analytics; (d) APIs and security. Findings and their fixes are logged in the review log below.

## Phases 2–8: complete application

| Phase | Implementation | Independent review | Testing | Owner approval |
|---|---|---|---|---|
| 2 Frontend: every screen on real backend data and actions | 🔄 inventory, then wiring | ⏳ frontend reviewer | ⏳ browser tests | ⏳ |
| 3 API integration (one client, consistent errors and auth) | ⏳ | ⏳ | ⏳ | ⏳ |
| 4 Database integrity (fresh install, migrations, rollback, FKs, idempotency) | partly ✅ from Phase 1 | ⏳ | ⏳ | ⏳ |
| 5 End-to-end workflows A–J in a real browser | ⏳ | ⏳ | ⏳ | ⏳ |
| 6 Security hardening | ⏳ (review round 1 (d) informs it) | 🔄 | ⏳ | ⏳ |
| 7 Reliable local run on MySQL (`eris_dev`) | ⏳ | ⏳ | ⏳ | ⏳ needs the owner to create the DB |
| 8 Documentation (setup, architecture, API, operations) | ⏳ | ⏳ | — | ⏳ |
| Deferred benchmarks (Step 3 run, Step 4 comparison; AC power, no concurrent Docker) | ⏳ | — | ⏳ | ⏳ |

## Decisions that are the owner's

| ID | Decision | Default used until decided |
|---|---|---|
| S6-1 | Resource **availability** forecast needs a length-of-stay model (not built). Build it, defer it, or accept the demand forecast plus current capacity | demand forecast only |
| S6-2 | The 20-observation minimum also gates means and acceptance rates (an extension of D8-a2) | applied |
| S6-3 | Forecast history starts at the first recorded case; `/history` and `/forecast` are ADMIN only; limits of 366 days and a 14-day horizon | applied |
| P7-1 | Create the local MySQL database `eris_dev` with your admin login (SQL provided; the agent never sees the password) | app keeps running in memory mode |
| G-1 | Publishing: `origin` is the team repository and PR #39 is open there. As a solo project, where should work be published, and in what commit layout? | nothing is committed or pushed |

## Review log

| Round | Area | Reviewer | Findings | Fixed | Re-reviewed |
|---|---|---|---|---|---|
| 1 | locking / concurrency / Banker's | independent agent | 🔄 | | |
| 1 | audit chain / schema / migrations | independent agent | 🔄 | | |
| 1 | store parity / analytics | independent agent | 🔄 | | |
| 1 | APIs / security | independent agent | 🔄 | | |

## Standing protections

- The original tree is never modified, and `js/app.js` is edited only in this integration tree.
- `MEMBER_ASSIGNMENTS_OS_DBMS.md` is excluded entirely: no edit, restore or delete in any tree. `VIVA_DEFENSE_GUIDE.md` stays deleted.
- MySQL migrations and tests run only against databases whose names end in `_test`. No production data, and credentials stay in the git-ignored `.env.local`.
- No staging, commits, pushes, PR changes, merges or deployments without the owner's separate approval.
- Step 2 baseline reports (`sim/reports/step2-baseline-*`) and workload fingerprints are never overwritten.
