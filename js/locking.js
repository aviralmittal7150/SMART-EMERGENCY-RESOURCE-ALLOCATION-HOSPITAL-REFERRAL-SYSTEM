// Concurrency, Soft-Locking, & Closed-Loop Referral Handshake Module

export class LockManager {
  constructor(onLockUpdate) {
    this.activeLock = null; // { hospitalId, requestId, expiresAt, timerId, remainingSec }
    this.onLockUpdate = onLockUpdate;
    this.lockDurationSec = 90;
  }

  /**
   * Acquire a 90-second Soft-Lock on candidate hospital resources
   */
  acquireLock(hospital, request, onTimeout) {
    if (this.activeLock) {
      this.releaseLock("PREEMPTED");
    }

    // Increment locked capacity
    if (hospital.resources.icuBeds.available > 0) {
      hospital.resources.icuBeds.locked += 1;
    }

    const expiresAt = Date.now() + (this.lockDurationSec * 1000);
    this.activeLock = {
      hospital,
      request,
      expiresAt,
      remainingSec: this.lockDurationSec,
      status: "LOCKED_PENDING_RESPONSE"
    };

    if (this.onLockUpdate) this.onLockUpdate(this.activeLock);

    this.timerId = setInterval(() => {
      if (!this.activeLock) {
        clearInterval(this.timerId);
        return;
      }

      this.activeLock.remainingSec -= 1;

      if (this.onLockUpdate) this.onLockUpdate(this.activeLock);

      if (this.activeLock.remainingSec <= 0) {
        clearInterval(this.timerId);
        this.handleTimeout(onTimeout);
      }
    }, 1000);

    return this.activeLock;
  }

  /**
   * Hospital ACCEPTS the referral -> Converts Soft Lock into Committed Allocation (ACID Transaction)
   */
  commitAllocation() {
    if (!this.activeLock) return null;

    clearInterval(this.timerId);
    const { hospital, request } = this.activeLock;

    // Atomic update
    if (hospital.resources.icuBeds.locked > 0) {
      hospital.resources.icuBeds.locked -= 1;
      hospital.resources.icuBeds.available = Math.max(0, hospital.resources.icuBeds.available - 1);
    }
    if (hospital.resources.ventilators.available > 0 && request.requiredResources?.includes("ventilators")) {
      hospital.resources.ventilators.available -= 1;
    }

    const committed = {
      ...this.activeLock,
      status: "COMMITTED_ACCEPTED",
      committedAt: new Date().toLocaleTimeString()
    };

    this.activeLock = null;
    if (this.onLockUpdate) this.onLockUpdate(committed);
    return committed;
  }

  /**
   * Hospital REJECTS the referral -> Release Soft Lock and Failover
   */
  rejectAllocation(onFailover) {
    if (!this.activeLock) return;

    clearInterval(this.timerId);
    const { hospital } = this.activeLock;

    if (hospital.resources.icuBeds.locked > 0) {
      hospital.resources.icuBeds.locked -= 1;
    }

    const rejected = {
      ...this.activeLock,
      status: "REJECTED_FAILOVER"
    };

    this.activeLock = null;
    if (this.onLockUpdate) this.onLockUpdate(rejected);
    if (onFailover) onFailover();
  }

  handleTimeout(onTimeout) {
    if (!this.activeLock) return;

    const { hospital } = this.activeLock;
    if (hospital.resources.icuBeds.locked > 0) {
      hospital.resources.icuBeds.locked -= 1;
    }

    const expired = {
      ...this.activeLock,
      status: "TIMEOUT_FAILOVER"
    };

    this.activeLock = null;
    if (this.onLockUpdate) this.onLockUpdate(expired);
    if (onTimeout) onTimeout();
  }

  releaseLock(reason = "CANCELLED") {
    if (this.timerId) clearInterval(this.timerId);
    if (this.activeLock && this.activeLock.hospital.resources.icuBeds.locked > 0) {
      this.activeLock.hospital.resources.icuBeds.locked -= 1;
    }
    this.activeLock = null;
    if (this.onLockUpdate) this.onLockUpdate(null);
  }
}
