<div align="center">

# 🏥 Smart Emergency Resource Allocation & Hospital Referral System

### *An OS & DBMS Driven Healthcare Logistics and Resource Coordination Engine*

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg?style=for-the-badge&logo=github-actions)](https://github.com/aviralmittal7150/SMART-EMERGENCY-RESOURCE-ALLOCATION-HOSPITAL-REFERRAL-SYSTEM)
[![OS Concepts](https://img.shields.io/badge/OS-Scheduling%20%7C%20Mutex%20%7C%20Banker's%20Algo-blue.svg?style=for-the-badge&logo=linux)](https://github.com/aviralmittal7150/SMART-EMERGENCY-RESOURCE-ALLOCATION-HOSPITAL-REFERRAL-SYSTEM)
[![DBMS](https://img.shields.io/badge/DBMS-ACID%20%7C%20Row--Level%20Locks-orange.svg?style=for-the-badge&logo=mysql)](https://github.com/aviralmittal7150/SMART-EMERGENCY-RESOURCE-ALLOCATION-HOSPITAL-REFERRAL-SYSTEM)
[![Concurrency](https://img.shields.io/badge/Concurrency-Zero%20Race%20Conditions-success.svg?style=for-the-badge)](https://github.com/aviralmittal7150/SMART-EMERGENCY-RESOURCE-ALLOCATION-HOSPITAL-REFERRAL-SYSTEM)
[![License](https://img.shields.io/badge/License-MIT-purple.svg?style=for-the-badge)](LICENSE)

<br/>

> **"Not just the nearest hospital — the nearest suitable hospital that can actually handle the emergency."**

</div>

---

## 📌 1. Executive Summary

During critical medical emergencies, the nearest hospital is often **not** the best destination. A facility 2 km away might have zero open ICU beds, no on-call interventional cardiologist, or an occupied emergency operating theatre (OT). Patients routed blindly by distance waste the golden hour in transfers.

The **Smart Emergency Resource Allocation & Hospital Referral System** solves this by uniting **Database Management Systems (DBMS)** with **Operating Systems (OS)** scheduling and synchronization principles. The system matches patients based on clinical resource demands, prioritizes severe triage cases, guarantees mutual exclusion on scarce beds, and prevents resource deadlocks.

---

## 🏛️ 2. High-Level System Architecture

```mermaid
flowchart TB
    subgraph INGESTION["🚨 1. Emergency Ingestion & Triage"]
        A["Caller / EMS Dispatch"] -->|"Patient Vitals & Symptoms"| B["Triage Priority Engine\n(Priority Queue: Level 1 to 5)"]
        B --> C["Required Resource Resolver\n(ICU Bed, Ventilator, Neuro, OT)"]
    end

    subgraph ENGINE["⚙️ 2. OS Allocation & Ranking Engine"]
        C --> D["Hard Constraint Filter\n(Capacity > 0 & Status == OPEN)"]
        D --> E["Hospital Suitability Scorer\n(Resource Fit + Acceptance + Capacity + Distance)"]
        E --> F["Ranked Candidate Queue"]
    end

    subgraph DBMS_LAYER["💾 3. DBMS & Concurrency Control Layer"]
        F -->|"Acquire 90s Soft-Lock"| G[("Central MySQL Registry\nSELECT ... FOR UPDATE")]
        G -->|"Alert Hospital Terminal"| H{"Hospital Response?"}
        H -->|"ACCEPTED"| I["Commit Atomic Allocation\n(available_capacity - 1)"]
        H -->|"REJECTED / TIMEOUT"| J["Release Soft-Lock\n(Failover to Rank #2)"]
        J --> F
    end

    subgraph DISPATCH["🚑 4. Logistics & Closed-Loop Lifecycle"]
        I --> K["Ambulance Auto-Dispatch & GPS Telemetry"]
        K --> L["Patient Arrival & In-Treatment"]
        L --> M["Treatment Complete -> Release Resource"]
        M --> N[("Immutable Audit History & Analytics")]
    end

    style INGESTION fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#fff
    style ENGINE fill:#1e293b,stroke:#a855f7,stroke-width:2px,color:#fff
    style DBMS_LAYER fill:#1e293b,stroke:#f59e0b,stroke-width:2px,color:#fff
    style DISPATCH fill:#1e293b,stroke:#10b981,stroke-width:2px,color:#fff
```

---

## 🔄 3. Emergency Process State Lifecycle (OS State Machine)

Just as an Operating System transitions processes through lifecycle states, emergency referral requests transition through a formal finite state machine:

```mermaid
stateDiagram-v2
    [*] --> NEW: 1. Emergency Triggered
    NEW --> WAITING: 2. Triage Level Assigned & Enqueued
    WAITING --> MATCHING: 3. Hospital DB Search & Suitability Scored
    MATCHING --> PENDING_ACCEPTANCE: 4. Soft Lock Placed (90s TTL) & Hospital Alerted
    
    PENDING_ACCEPTANCE --> ALLOCATED: 5a. Hospital ACCEPTS (Lock Committed)
    PENDING_ACCEPTANCE --> MATCHING: 5b. Hospital REJECTS / TIMEOUT (Lock Released & Next Hospital)
    
    ALLOCATED --> IN_TRANSIT: 6. Ambulance Dispatched
    IN_TRANSIT --> IN_TREATMENT: 7. Patient Arrives at Facility
    IN_TREATMENT --> COMPLETED: 8. Treatment Finished & Resources Released
    COMPLETED --> [*]
```

---

## 🧠 4. OS & DBMS Concept Matrix

| Computer Science Concept | OS / DBMS Mechanism | Real-World Healthcare Application |
| :--- | :--- | :--- |
| **Priority Scheduling** | Preemptive Multi-Level Priority Queue | Resuscitation cases (Triage 1) preempt urgent/stable cases in resource evaluation. |
| **Mutual Exclusion (Mutex)** | Row-Level Locks (`SELECT ... FOR UPDATE`) | Prevents simultaneous double-booking of a single remaining ICU bed or ventilator. |
| **Process Synchronization** | Soft Lock + 90s Countdown Handshake | Synchronizes hospital acceptance before ambulance wheels roll, avoiding futile patient routing. |
| **Deadlock Avoidance** | **Banker's Algorithm** (Safe Sequence Check) | Evaluates multi-resource claims (ICU + Ventilator + Neuro Specialist) to avoid hospital gridlock. |
| **ACID Atomicity & Rollback** | Transactional Commit / Rollback | Automatically reverts temporary reservations if hospital rejects or transfer fails. |
| **Resource Release** | Deallocation Hook | Automatically returns beds and specialists to the available pool upon patient discharge. |

---

## 🔒 5. Banker's Algorithm Safe-State Workflow

When multiple emergencies require compound scarce resources, the system computes the safety state to guarantee system viability:

```mermaid
flowchart LR
    A["Incoming Claim\nRequest: [ICU:1, Vent:1, Doc:1]"] --> B{"Is Request <=\nAvailable Capacity?"}
    B -- No --> C["❌ Block / Defer / Reroute\n(Avoid Deadlock)"]
    B -- Yes --> D["Simulate Allocation\nAvailable' = Available - Request\nAllocated' = Allocated + Request"]
    D --> E{"Banker's Safe State?\nFind Safe Sequence P0...Pn"}
    E -- Safe Sequence Found --> F["✅ Grant Lock & Commit"]
    E -- Unsafe State Detected --> G["⚠️ Deny Immediate Lock\nReroute to Alternative Hospital"]
    
    style A fill:#334155,stroke:#94a3b8,color:#fff
    style C fill:#7f1d1d,stroke:#ef4444,color:#fff
    style F fill:#064e3b,stroke:#10b981,color:#fff
    style G fill:#78350f,stroke:#f59e0b,color:#fff
```

---

## 📊 6. Hospital Suitability Ranking Formula

Instead of sorting purely by physical distance, the matching engine computes a multi-attribute weighted score:

$$\mathbf{Suitability\ Score} = (0.40 \times \mathbf{RF}) + (0.25 \times \mathbf{AR}) + (0.20 \times \mathbf{CC}) + (0.15 \times \mathbf{DP})$$

Where:
- **$\mathbf{RF}$ (Resource Fit - 40%):** Matches required equipment (ICU beds, pediatric ventilators, trauma OTs, cardiology staff). Any missing mandatory requirement immediately drops score to $0$.
- **$\mathbf{AR}$ (Acceptance & Response Rate - 25%):** Historical percentage of referrals accepted and average response latency ($< 60\text{s}$).
- **$\mathbf{CC}$ (Critical Capacity - 20%):** Ratio of available critical beds vs total capacity (penalizes saturated hospitals).
- **$\mathbf{DP}$ (Distance Proximity - 15%):** Normalized distance / estimated transit duration.

---

## 🗄️ 7. Entity Relationship Schema (DBMS)

```mermaid
erDiagram
    HOSPITAL ||--o{ DOCTOR : employs
    HOSPITAL ||--o{ MEDICAL_RESOURCE : owns
    HOSPITAL ||--o{ AMBULANCE : stations
    HOSPITAL ||--o{ HOSPITAL_ACCEPTANCE : receives
    PATIENT ||--o{ EMERGENCY_REQUEST : initiates
    EMERGENCY_REQUEST ||--o{ RESOURCE_ALLOCATION : claims
    EMERGENCY_REQUEST ||--o{ HOSPITAL_ACCEPTANCE : targets
    EMERGENCY_REQUEST ||--o{ EMERGENCY_HISTORY : logs
    MEDICAL_RESOURCE ||--o{ RESOURCE_ALLOCATION : allocated_in

    HOSPITAL {
        int hospital_id PK
        string hospital_name
        decimal latitude
        decimal longitude
        enum emergency_status "OPEN | LIMITED | CLOSED"
        decimal rating
    }

    MEDICAL_RESOURCE {
        int resource_id PK
        int hospital_id FK
        enum resource_type "ICU_BED | VENTILATOR | OT | SPECIALIST"
        int total_capacity
        int available_capacity
        int locked_capacity
        int version_lock
    }

    EMERGENCY_REQUEST {
        int request_id PK
        int patient_id FK
        enum emergency_type "CARDIAC | TRAUMA | STROKE | RESPIRATORY"
        int priority "1 (Highest) to 5 (Lowest)"
        enum status "NEW | WAITING | ALLOCATED | IN_TREATMENT | COMPLETED"
        datetime request_time
    }

    RESOURCE_ALLOCATION {
        int allocation_id PK
        int request_id FK
        int resource_id FK
        enum status "LOCKED | COMMITTED | RELEASED"
        datetime allocated_at
        datetime released_at
    }
```

---

## 🚀 8. Quick Start & Local Setup

### 8.1 Prerequisites
- **Node.js:** v18.0.0 or later
- **MySQL:** v8.0 or PostgreSQL
- **Git**

### 8.2 Installation

```bash
# 1. Clone repository
git clone https://github.com/aviralmittal7150/SMART-EMERGENCY-RESOURCE-ALLOCATION-HOSPITAL-REFERRAL-SYSTEM.git

# 2. Enter directory
cd "SMART EMERGENCY RESOURCE ALLOCATION & HOSPITAL REFERRAL SYSTEM"

# 3. Install dependencies
npm install

# 4. Configure environment variables
cp .env.example .env
```

### 8.3 Run Concurrency & OS Test Suite

```bash
# Execute unit, integration, and concurrency stress tests
npm test
```

### 8.4 Start Development Server

```bash
npm run dev
# Server listening at http://localhost:3000
```

---

## 🧪 9. Concurrency & Stress Verification Matrix

| Test Suite | Scenario Tested | Target Assertion | Result |
| :--- | :--- | :--- | :---: |
| `unit/scoring` | Suitability score weighted calculation | Correct weights and exclusion on missing resource | ✅ **PASS** |
| `unit/priority` | Min-heap Priority Queue triage ordering | Priority 1 cases precede Priority 3 | ✅ **PASS** |
| `integration/handshake` | 90s Soft Lock & Acceptance flow | Row lock held $\to$ Committed upon accept | ✅ **PASS** |
| `integration/failover` | Hospital rejection & timeout auto-routing | Lock released $\to$ Immediate failover to Rank 2 | ✅ **PASS** |
| `concurrency/mutex` | **50 concurrent threads claiming 1 ICU bed** | **Zero double-allocations (1 winner, 49 rerouted)** | ✅ **PASS** |
| `simulation/bankers` | Multi-resource claim safe sequence | Detects unsafe state and avoids deadlock | ✅ **PASS** |

---

## 📂 10. Repository Documentation Index

| File | Description |
| :--- | :--- |
| 📘 **[PRD.md](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/PRD.md)** | Complete Product Requirements Document with full data schema and non-functional specifications. |
| 🔄 **[WORKFLOW.md](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/WORKFLOW.md)** | End-to-end task workflows, GitHub Issue templates, and Pull Request guidelines. |
| 🤖 **[AGENTS.md](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/AGENTS.md)** | AI Agent & Contributor operating handbook with strict OS/DBMS mandates. |
| 📋 **[.github/pull_request_template.md](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/.github/pull_request_template.md)** | Standard Pull Request template with mandatory test matrix. |

---

## 🎯 11. Viva & Academic Defense Highlights

<details>
<summary><b>💬 Click to view 1-Minute Viva Elevator Pitch</b></summary>

> *"Our project is a **Smart Emergency Resource Allocation and Hospital Referral System**. In medical emergencies, routing patients to the nearest hospital often fails when that hospital lacks an open ICU bed, ventilator, or specialist. Our **DBMS** stores real-time registries of hospitals, equipment, doctors, ambulances, and audit trails. Our **OS engine** applies Priority Scheduling for patient triage, Mutual Exclusion to prevent double-allocations, and Banker's Algorithm to avoid multi-resource deadlocks. The system delivers closed-loop acceptance before transit, ensuring patients reach the nearest **suitable** facility."*

</details>

<details>
<summary><b>❓ Key Viva Questions Answered</b></summary>

1. **How do you handle race conditions?**  
   *Through DBMS row-level locks (`SELECT ... FOR UPDATE`) and temporary 90-second soft-locks with automatic rollback.*
2. **Why not just choose the closest hospital?**  
   *Proximity is useless if the hospital lacks critical resources. Our multi-factor algorithm scores resource fit (40%), acceptance rate (25%), capacity (20%), and distance (15%).*
3. **Where is the Banker's Algorithm used?**  
   *When high-severity patients require bundles of scarce resources (e.g. ICU Bed + Ventilator + Trauma Surgeon), the Banker's Algorithm verifies that allocating those resources will not place the regional hospital cluster into an unsafe, deadlock state.*

</details>

---

## 🛡️ 12. Safety Boundary Declaration

> [!IMPORTANT]
> **Operational Scope:** This software is an administrative resource management and logistics coordination platform. It **does not** provide automated medical diagnosis or clinical prescription. Final patient acceptance and treatment plans remain exclusively under the clinical discretion of licensed medical professionals.

---

<div align="center">
  <sub>Built with ❤️ for Computer Science & Healthcare Logistics Engineering.</sub>
</div>
