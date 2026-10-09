// js/bankers.js
// OS Banker's Algorithm Safe-State Detection & Compound Multi-Resource Claims Engine (Issue #25)
// Supports both classic 3-resource vector [ICU, Vent, Specialist] and arbitrary N-vector compound claims.

export class BankersAlgorithm {
  constructor(
    processes = ["P0 (Cardiac)", "P1 (Polytrauma)", "P2 (Stroke)", "P3 (Respiratory)"],
    resourceNames = ["ICU Beds", "Ventilators", "Specialists"]
  ) {
    this.processes = processes;
    this.resourceNames = resourceNames;

    // Available Vector: [ICU, Vent, Specialist]
    this.available = [3, 3, 2];

    // Allocation Matrix (Current resources held)
    this.allocation = [
      [0, 1, 0], // P0
      [2, 0, 0], // P1
      [3, 0, 2], // P2
      [2, 1, 1]  // P3
    ];

    // Maximum Claims Matrix
    this.max = [
      [7, 5, 3], // P0
      [3, 2, 2], // P1
      [9, 0, 2], // P2
      [2, 2, 2]  // P3
    ];
  }

  /**
   * Need[i][j] = Max[i][j] - Allocation[i][j]
   */
  getNeedMatrix() {
    const need = [];
    for (let i = 0; i < this.processes.length; i++) {
      need[i] = [];
      for (let j = 0; j < this.resourceNames.length; j++) {
        const maxVal = this.max[i]?.[j] ?? 0;
        const allocVal = this.allocation[i]?.[j] ?? 0;
        need[i][j] = Math.max(0, maxVal - allocVal);
      }
    }
    return need;
  }

  /**
   * Evaluates if the current state is safe and outputs step-by-step trace
   */
  evaluateSafety() {
    const numP = this.processes.length;
    const numR = this.resourceNames.length;
    const need = this.getNeedMatrix();

    const work = [...this.available];
    const finish = new Array(numP).fill(false);
    const safeSequence = [];
    const traceLogs = [];
    const workVectors = [[...work]];

    traceLogs.push(`Initial Available Vector: [${work.join(", ")}] (${this.resourceNames.join(", ")})`);

    let count = 0;
    while (count < numP) {
      let found = false;

      for (let p = 0; p < numP; p++) {
        if (!finish[p]) {
          // Check if Need[p] <= Work across all resource vectors
          let canAllocate = true;
          for (let r = 0; r < numR; r++) {
            if (need[p][r] > work[r]) {
              canAllocate = false;
              break;
            }
          }

          if (canAllocate) {
            traceLogs.push(
              `Step ${count + 1}: ${this.processes[p]} has Need [${need[p].join(", ")}] <= Available [${work.join(", ")}]. Executing...`
            );

            for (let r = 0; r < numR; r++) {
              work[r] += this.allocation[p][r];
            }

            safeSequence.push(this.processes[p]);
            finish[p] = true;
            found = true;
            count++;

            traceLogs.push(
              `-> ${this.processes[p]} finished & released [${this.allocation[p].join(", ")}]. New Available: [${work.join(", ")}]`
            );
            workVectors.push([...work]);
            break;
          }
        }
      }

      if (!found) {
        traceLogs.push(`⚠️ DEADLOCK HAZARD: Circular wait or resource starvation detected! System is in an UNSAFE state.`);
        return {
          isSafe: false,
          safeSequence: [],
          traceLogs,
          workVectors
        };
      }
    }

    traceLogs.push(`✅ SAFE STATE DETECTED! Safe Execution Sequence: < ${safeSequence.join(" ➔ ")} >`);
    return {
      isSafe: true,
      safeSequence,
      traceLogs,
      workVectors
    };
  }

  /**
   * P3-02 Compound Claim Request Check:
   * Evaluates if allocating a multi-resource compound request to process processIndex maintains safe state.
   */
  requestResources(processIndex, requestVector) {
    const numR = this.resourceNames.length;
    const need = this.getNeedMatrix();

    // 1. Check if Request <= Need
    for (let r = 0; r < numR; r++) {
      if (requestVector[r] > need[processIndex][r]) {
        return {
          granted: false,
          reason: `Error: Process exceeded maximum claim for resource ${this.resourceNames[r]}`
        };
      }
    }

    // 2. Check if Request <= Available
    for (let r = 0; r < numR; r++) {
      if (requestVector[r] > this.available[r]) {
        return {
          granted: false,
          reason: `Insufficient ${this.resourceNames[r]} available. Process must wait.`
        };
      }
    }

    // 3. Pretend to allocate and check safety
    for (let r = 0; r < numR; r++) {
      this.available[r] -= requestVector[r];
      this.allocation[processIndex][r] += requestVector[r];
    }

    const safetyCheck = this.evaluateSafety();

    if (safetyCheck.isSafe) {
      return {
        granted: true,
        reason: `Compound claim granted safely! Safe sequence: < ${safetyCheck.safeSequence.join(" ➔ ")} >`,
        safeSequence: safetyCheck.safeSequence,
        traceLogs: safetyCheck.traceLogs
      };
    } else {
      // Rollback
      for (let r = 0; r < numR; r++) {
        this.available[r] += requestVector[r];
        this.allocation[processIndex][r] -= requestVector[r];
      }

      return {
        granted: false,
        reason: `Deadlock avoidance: Granting compound claim would transition system into an UNSAFE state. Allocation rejected!`,
        traceLogs: safetyCheck.traceLogs
      };
    }
  }

  /**
   * Helper to initialize a 4-resource compound model (ICU, Vent, Specialist, OT)
   */
  static createCompoundModel() {
    return new BankersAlgorithm(
      ["P0 (Cardiac)", "P1 (Polytrauma)", "P2 (Stroke)", "P3 (Respiratory)"],
      ["ICU Beds", "Ventilators", "Specialists", "Operating Theatres"]
    );
  }
}
