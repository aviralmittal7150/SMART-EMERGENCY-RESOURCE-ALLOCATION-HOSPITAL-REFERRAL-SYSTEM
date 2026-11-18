# 🗂️ Project Explorer: OS & DBMS Mode Organization Guide

> **Smart Emergency Resource Allocation & Hospital Referral System (ERIS)**  
> This document details the dual **Operating Systems (OS)** and **Database Management Systems (DBMS)** mode directory layout in the project explorer.

---

## 🧭 Visual Explorer Layout

When browsing the project tree in your IDE file explorer (VS Code / Antigravity), the codebase is organized into two dedicated concept folders alongside the application layers:

```
SMART EMERGENCY RESOURCE ALLOCATION & HOSPITAL REFERRAL SYSTEM
│
├── ⚙️ os/                                    <── [OS MODE EXPLORER]
│   ├── 01_priority_scheduling_minheap.js       -> js/triage.js
│   ├── 02_mutual_exclusion_softlock.js        -> js/locking.js
│   ├── 03_bankers_deadlock_avoidance.js       -> js/bankers.js
│   ├── 04_backend_locking_engine.js           -> server/services/lockingEngine.js
│   ├── 05_concurrency_stress_test.js          -> tests/concurrency_stress.test.js
│   ├── 06_process_lifecycle_test.js           -> tests/lifecycle.test.js
│   ├── 07_bankers_algorithm_test.js           -> tests/bankers.test.js
│   ├── 08_compound_deadlock_test.js           -> tests/bankers_compound.test.js
│   └── README.md
│
├── 💾 dbms/                                  <── [DBMS MODE EXPLORER]
│   ├── 01_relational_schema_10_tables.sql     -> server/db/schema.sql
│   ├── 02_database_seed_data.js               -> server/db/seed.js
│   ├── 03_mysql_connection_pool.js            -> server/db/pool.js
│   ├── 04_sha256_immutable_audit_ledger.js    -> js/audit_ledger.js
│   ├── 05_acid_transactions_referral_routes.js-> server/routes/referrals.js
│   ├── 06_aggregate_analytics_queries.js      -> server/routes/analytics.js
│   ├── 07_audit_ledger_test.js                -> tests/audit_ledger.test.js
│   └── README.md
│
├── 🖥️ Application Core Layers
│   ├── index.html                             (Frontend Single Page Application)
│   ├── js/                                    (Vanilla JS Module Controllers)
│   ├── css/                                   (Modular Stylesheets)
│   ├── server/                                (Express.js REST API & Socket.io)
│   └── tests/                                 (49 Automated Node.js Tests)
│
└── 🎬 demo-video/                             (Video Deliverables & Screenshots)
    ├── project-demo.mp4                       (1080p 24fps 4-minute demo video)
    ├── demo-script.md                         (Scene narration and action script)
    ├── demo-report.md                         (Feature and test audit report)
    └── screenshots/                           (25 HD Screenshots)
```

---

## 👥 4-Member Role & File Ownership Mapping

```
┌──────────────┬──────────────────────────────┬──────────────────────────────┬──────────────────────────────────┐
│ Team Member  │ ⚙️ OS Mode Explorer Files     │ 💾 DBMS Mode Explorer Files   │ Core Responsibility              │
├──────────────┼──────────────────────────────┼──────────────────────────────┼──────────────────────────────────┤
│ 👑 Aviral    │ `os/01_priority_scheduling*` │ `dbms/01_relational_schema*` │ Priority Queue, GPS Math, Intake │
│ ⚡ Saurabh   │ `os/02_mutual_exclusion*`    │ `dbms/05_acid_transactions*` │ 90s Soft-Lock, Mutex, Row Locks  │
│              │ `os/04_backend_locking*`     │                              │                                  │
│              │ `os/05_concurrency_stress*`  │                              │                                  │
│ 🧠 Devansh   │ `os/03_bankers_deadlock*`    │ `dbms/01_relational_schema*` │ Banker's Algo, Relational Schema │
│              │ `os/07_bankers_algorithm*`   │ `dbms/02_database_seed*`     │ 10 Tables, Foreign Keys          │
│              │ `os/08_compound_deadlock*`   │ `dbms/03_mysql_connection*`  │                                  │
│ 📊 Om        │ `os/06_process_lifecycle*`   │ `dbms/04_sha256_immutable*`  │ Process States, SHA-256 Ledger,  │
│              │                              │ `dbms/06_aggregate_analytics*│ Command Center & EMS Dispatch    │
│              │                              │ `dbms/07_audit_ledger_test*` │                                  │
└──────────────┴──────────────────────────────┴──────────────────────────────┴──────────────────────────────────┘
```

---

## ⚡ Quick Test Verification Commands

Each mode has corresponding test commands defined in `package.json`:

```bash
# ── OS Mode Tests ──
npm run test:triage        # Tests Priority Queue & Min-Heap
npm run test:locking       # Tests 90s Soft-Lock & Concurrency Mutex
npm run test:bankers       # Tests Banker's Algorithm Deadlock Avoidance
npm run test:concurrency   # Tests 100 threads competing for 1 bed
npm run test:lifecycle     # Tests 6 OS Process States
npm run test:compound      # Tests Multi-resource vector claims

# ── DBMS Mode Tests ──
npm run test:audit         # Tests SHA-256 Audit Ledger Chain
npm test tests/phase2_backend.test.js  # Tests Database Layer & REST APIs

# ── Run All 49 Tests ──
npm test
```
