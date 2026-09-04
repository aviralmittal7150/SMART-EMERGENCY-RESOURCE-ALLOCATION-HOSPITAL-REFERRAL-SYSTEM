// OS Banker's Algorithm Safe-State Detection & Deadlock Avoidance Module

export class BankersAlgorithm {
  constructor(processes = ["P0 (Cardiac)", "P1 (Polytrauma)", "P2 (Stroke)", "P3 (Respiratory)"], resourceNames = ["ICU Beds", "Ventilators", "Specialists"]) {
    this.processes = processes;
    this.resourceNames = resourceNames;
    
    // Default matrix state
    this.available = [3, 3, 2]; // Total Available [ICU, Vent, Specialist]
    
    this.allocation = [
      [0, 1, 0], // P0
      [2, 0, 0], // P1
      [3, 0, 2], // P2
      [2, 1, 1]  // P3
    ];

    this.max = [
      [7, 5, 3], // P0 Max
      [3, 2, 2], // P1 Max
      [9, 0, 2], // P2 Max
      [2, 2, 2]  // P3 Max
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
        need[i][j] = Math.max(0, this.max[i][j] - this.allocation[i][j]);
      }
    }
    return need;
  }

  /**
   * Executes Banker's Safety Algorithm
   * Returns { isSafe: boolean, safeSequence: string[], traceLogs: string[], workVectors: number[][] }
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
          // Check if Need[p] <= Work
          let canAllocate = true;
          for (let r = 0; r < numR; r++) {
            if (need[p][r] > work[r]) {
              canAllocate = false;
              break;
            }
          }

          if (canAllocate) {
            // Allocate work
            traceLogs.push(`Step ${count + 1}: ${this.processes[p]} has Need [${need[p].join(", ")}] <= Available [${work.join(", ")}]. Executing...`);
            
            for (let r = 0; r < numR; r++) {
              work[r] += this.allocation[p][r];
            }
            
            safeSequence.push(this.processes[p]);
            finish[p] = true;
            found = true;
            count++;
            
            traceLogs.push(`-> ${this.processes[p]} finished. Released Allocation [${this.allocation[p].join(", ")}]. New Available: [${work.join(", ")}]`);
            workVectors.push([...work]);
            break;
          }
        }
      }

      if (!found) {
        traceLogs.push(`⚠️ DEADLOCK HAZARD: No remaining process has Need <= Available. System is in an UNSAFE state!`);
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
}
