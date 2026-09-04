# Smart Emergency Resource Allocation & Hospital Referral System

> **"Not just the nearest hospital — the nearest suitable hospital that can actually handle the emergency."**

An intelligent emergency healthcare logistics system bridging real-world clinical coordination with **Operating Systems (OS)** and **Database Management Systems (DBMS)** principles.

---

## 📑 Core Documentation

- 📘 **[PRD.md](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/PRD.md):** Full Product Requirements Document with data schemas, scoring algorithms, and system specifications.
- 🔄 **[WORKFLOW.md](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/WORKFLOW.md):** Emergency request lifecycle, engineering workflows, GitHub Issue templates, and PR guidelines.
- 🤖 **[AGENTS.md](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/AGENTS.md):** Operating handbook for AI agents and developers with strict OS/DBMS constraints and verification standards.

---

## 🎯 Key Capabilities

1. **Smart Resource Matching:** Dynamically filters and ranks hospitals by ICU beds, ventilators, operating theatres, and on-call specialist availability.
2. **OS Scheduling & Priority Queues:** Preemptive triage prioritization (Level 1 Resuscitation down to Level 5 Non-urgent).
3. **Mutual Exclusion & Concurrency Control:** Row-level locks and 90-second soft-locks prevent double-allocation under high concurrent demand.
4. **Deadlock & Safe-State Avoidance:** Implementation and visual simulation of Banker's Algorithm for multi-resource allocations.
5. **Closed-Loop Referral Handshake:** Fast acceptance/rejection flow with automated failover to the next optimal candidate hospital.
6. **Live Operations Command Center:** Real-time metrics, capacity heatmaps, response time analytics, and ambulance telemetry.

---

## 🛠️ Tech Stack

- **Frontend:** HTML5 / CSS3 / JavaScript (Vanilla / Modern UI)
- **Backend:** Node.js + Express
- **Database:** MySQL / Relational DBMS with ACID transactional isolation
- **Algorithms:** Priority Queue, Mutex / Soft Locking, Banker's Algorithm Safe Sequence Detection

---

## 🚀 GitHub Standards

- **Issue Templates:** Standardized templates available in `.github/ISSUE_TEMPLATE/` for Feature Requests and Bug Reports.
- **Pull Request Standards:** Enforced checklist and test verification matrix in `.github/pull_request_template.md`.
