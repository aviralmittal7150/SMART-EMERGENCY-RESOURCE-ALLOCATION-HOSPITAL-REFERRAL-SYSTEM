# ⚙️ Operating Systems (OS) Mode — Project Explorer Directory

This directory organizes all codebase files related to **Operating Systems (OS) concepts**, allowing examiners, evaluators, and developers to explore the OS architecture directly from the project explorer.

---

## 📂 OS File Directory Map

| File in `os/` | Original File Link | OS Principle Implemented | Assigned Lead |
| :--- | :--- | :--- | :--- |
| [`01_priority_scheduling_minheap.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/js/triage.js) | `js/triage.js` | **Priority Scheduling & Preemption**<br>Triage Level $P1 > P5$, Min-Heap queue with FIFO tie-breaking | 👑 Aviral |
| [`02_mutual_exclusion_softlock.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/js/locking.js) | `js/locking.js` | **Mutual Exclusion (Mutex) & Soft-Locking**<br>90-second TTL countdown timer, race condition prevention | ⚡ Saurabh |
| [`03_bankers_deadlock_avoidance.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/js/bankers.js) | `js/bankers.js` | **Deadlock Avoidance (Banker's Algorithm)**<br>Safe-state detector, Need matrix calculation, Safe sequence finder | 🧠 Devansh |
| [`04_backend_locking_engine.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/server/services/lockingEngine.js) | `server/services/lockingEngine.js` | **Concurrency Controller & Event Handlers**<br>EventEmitter for lock acquisition, release, timeout & failover | ⚡ Saurabh |
| [`05_concurrency_stress_test.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/tests/concurrency_stress.test.js) | `tests/concurrency_stress.test.js` | **Concurrency Verification Suite**<br>100 parallel requests competing for 1 bed $\to$ 0 double allocations | ⚡ Saurabh |
| [`06_process_lifecycle_test.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/tests/lifecycle.test.js) | `tests/lifecycle.test.js` | **Process State Machine Verification**<br>`NEW` $\to$ `WAITING` $\to$ `ALLOCATED` $\to$ `IN_TREATMENT` $\to$ `RELEASED` | 📊 Om |
| [`07_bankers_algorithm_test.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/tests/bankers.test.js) | `tests/bankers.test.js` | **Banker's Algorithm Core Tests**<br>Need matrix and safe sequence assertions | 🧠 Devansh |
| [`08_compound_deadlock_test.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/tests/bankers_compound.test.js) | `tests/bankers_compound.test.js` | **Compound Claims Deadlock Avoidance**<br>4-resource vector requests under heavy resource saturation | 🧠 Devansh |

---

## 🧪 How to Run OS Test Suite

```bash
# Run all OS test suites
npm run test:triage
npm run test:locking
npm run test:bankers
npm run test:concurrency
npm run test:lifecycle
npm run test:compound
```
