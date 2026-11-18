# 📋 Individual Work Assignments: Separated by OS & DBMS Tasks

### **Smart Emergency Resource Allocation & Hospital Referral System**

---

## 👑 1. Aviral (Team Lead — Scheduling & Matching)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 👑 AVIRAL'S SCOPE OF WORK                                                   │
├───────────────────┬─────────────────────────────────────────────────────────┤
│ ⚙️ OS Tasks       │ • Priority Scheduling: Triage Level 1 > Level 5         │
│                   │ • Min-Heap Priority Queue for incoming requests         │
│                   │ • FIFO Tie-Breaking on identical triage priority        │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 💾 DBMS Tasks     │ • Query filtering: `emergency_status = 'OPEN'`          │
│                   │ • Capacity verification: `available_capacity > 0`       │
│                   │ • Fast indexing on `location` and `emergency_type`      │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 🖥️ Frontend Work  │ • Patient Emergency Intake Form (Name, Age, Vitals)     │
│                   │ • Triage Buttons P1–P5 with clinical colors             │
│                   │ • Required Resource Checkbox Chips (ICU, Vent, Doc)     │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ ⚙️ Backend Work   │ • Suitability Ranking Math Engine (40% RF, 25% AR, ...) │
│                   │ • Candidate Hospital Sorter & Exclusion Filter          │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

### Aviral's Specific Tasks:
1. **OS Task 1 (Priority Queue):** Code the comparator that puts Level 1 cases at the top of the waiting queue ahead of Level 3 cases.
2. **OS Task 2 (Scheduling Policy):** Ensure that new high-priority arrivals preempt lower-priority requests in the matching pipeline.
3. **DBMS Task 1 (Filtering):** Write database queries that immediately drop hospitals marked as `CLOSED` or missing mandatory specialist doctors.
4. **DBMS Task 2 (Schema Indexing):** Define database indexes on `emergency_type` and `location` for sub-250ms search latency.

---

## ⚡ 2. Saurabh (Concurrency & Locking Lead)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚡ SAURABH'S SCOPE OF WORK                                                  │
├───────────────────┬─────────────────────────────────────────────────────────┤
│ ⚙️ OS Tasks       │ • Mutual Exclusion (Mutex) on scarce beds & ventilators │
│                   │ • 90-Second Soft-Lock Timer (TTL Countdown)             │
│                   │ • Timer Interrupt & Automatic Timeout Failover          │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 💾 DBMS Tasks     │ • Row-Level Locking: `SELECT ... FOR UPDATE`            │
│                   │ • Atomic Transaction Commit on Hospital Acceptance      │
│                   │ • Transaction Rollback on Rejection / Timeout           │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 🖥️ Frontend Work  │ • Hospital Acceptance Console with 90s Countdown Timer  │
│                   │ • 1-Click Accept & Reject Decision Buttons              │
│                   │ • Audio/Visual Emergency Referral Alert Animation       │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ ⚙️ Backend Work   │ • Concurrency Lock Manager (prevents race conditions)   │
│                   │ • Automated Failover Rerouter to Rank #2 Hospital       │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

### Saurabh's Specific Tasks:
1. **OS Task 1 (Mutual Exclusion):** Implement mutual exclusion locking so that if 50 requests arrive for 1 ICU bed, only 1 request wins the lock.
2. **OS Task 2 (TTL Soft-Lock):** Build the 90-second soft-lock timer that temporarily holds a bed while the hospital decides.
3. **DBMS Task 1 (Row-Level Locking):** Implement `SELECT ... FOR UPDATE` on `MedicalResource` table rows to prevent concurrent read/write race conditions.
4. **DBMS Task 2 (ACID Atomicity):** Ensure atomic commit (`available_capacity - 1`, `locked_capacity - 1`) on accept, and rollback on reject.

---

## 🧠 3. Devansh (Deadlock Avoidance & DBMS Schema Lead)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🧠 DEVANSH'S SCOPE OF WORK                                                  │
├───────────────────┬─────────────────────────────────────────────────────────┤
│ ⚙️ OS Tasks       │ • Deadlock Avoidance using **Banker's Algorithm**       │
│                   │ • Resource-Request Safety Algorithm for Compound Claims │
│                   │ • Safe Sequence Detection (<P0 ➔ P1 ➔ P2 ➔ P3>)         │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 💾 DBMS Tasks     │ • Complete 10-Table Relational Schema Architecture      │
│                   │ • Primary Keys (PK), Foreign Keys (FK) & Normalization  │
│                   │ • Specialist & Doctor Shift Tables (`Doctor`, `Shift`)  │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 🖥️ Frontend Work  │ • Interactive Banker's Matrix Table UI                  │
│                   │ • Dynamic Available, Max, & Allocation Vector Inputs    │
│                   │ • Step-by-Step Safe Sequence / Deadlock Warning Display │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ ⚙️ Backend Work   │ • Need Matrix Math Computation (`Need = Max - Alloc`)   │
│                   │ • Vector comparison loop (Can Need[i] <= Available?)    │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

### Devansh's Specific Tasks:
1. **OS Task 1 (Banker's Algorithm):** Implement the safety algorithm to verify that compound resource allocations (ICU + Ventilator + Specialist) will not cause system deadlock.
2. **OS Task 2 (Safe Sequence Finder):** Calculate the valid process completion order ($\langle P_0 \to P_1 \to P_2 \dots \rangle$) and detect unsafe states.
3. **DBMS Task 1 (Database Schema):** Design and create the 10 normalized tables (`Hospital`, `Doctor`, `MedicalResource`, `Patient`, `EmergencyRequest`, etc.).
4. **DBMS Task 2 (Integrity Constraints):** Set up foreign key constraints and cascade rules across hospitals, resources, and allocations.

---

## 📊 4. Om (Operations Command Center & Lifecycle Lead)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 📊 OM'S SCOPE OF WORK                                                       │
├───────────────────┬─────────────────────────────────────────────────────────┤
│ ⚙️ OS Tasks       │ • OS Process State Machine:                             │
│                   │   NEW ➔ WAITING ➔ ALLOCATED ➔ IN_TREATMENT ➔ COMPLETED  │
│                   │ • Resource Deallocation Hook on Process Termination     │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 💾 DBMS Tasks     │ • Aggregate SQL Analytics Queries (`COUNT`, `AVG`)      │
│                   │ • Immutable Audit Logging Table (`EmergencyHistory`)    │
│                   │ • Historical Demand & Response Latency Reports          │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ 🖥️ Frontend Work  │ • Command Center Dashboard (6 KPI Cards, Status Tokens) │
│                   │ • Regional Hospital Capacity Directory Grid             │
│                   │ • EMS Ambulance Fleet Tracking UI                       │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ ⚙️ Backend Work   │ • Process State Transition Handlers                     │
│                   │ • Automated Unit & Concurrency Test Runner (`npm test`) │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

### Om's Specific Tasks:
1. **OS Task 1 (Process Lifecycle):** Implement the 5 process states (`NEW` $\to$ `WAITING` $\to$ `ALLOCATED` $\to$ `IN_TREATMENT` $\to$ `COMPLETED`).
2. **OS Task 2 (Resource Release):** When a patient status changes to `COMPLETED`, trigger an automatic deallocation hook that returns the bed to available capacity.
3. **DBMS Task 1 (Audit Logging):** Write permanent, timestamped transition logs into `EmergencyHistory` for medico-legal tracking.
4. **DBMS Task 2 (Aggregations):** Write queries to calculate total active cases, average hospital response times, and network capacity utilization.

---

## 🎯 Master Summary Table

| Team Member | Core OS Responsibility | Core DBMS Responsibility | Frontend Deliverable | Backend Deliverable |
| :--- | :--- | :--- | :--- | :--- |
| **👑 Aviral** | Priority Scheduling & Min-Heap | Hospital Search & Fast Indexing | Emergency Intake Screen | Suitability Scoring Formula |
| **⚡ Saurabh** | Mutual Exclusion & 90s Soft-Lock | Row-Level Locks & ACID Rollback | Hospital Acceptance Console | Lock Manager & Auto Failover |
| **🧠 Devansh** | Deadlock Avoidance (Banker's) | 10-Table Relational Schema | Banker's Matrix Visualizer | Need Matrix & Safe Sequence |
| **📊 Om** | Process States & Resource Release| Audit History & Aggregations | Command Center & EMS Fleet | State Tracker & Test Suite |
