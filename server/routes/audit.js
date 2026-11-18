// server/routes/audit.js
// Audit ledger integrity — /api/v1/audit (Phase 3 Step 5)

import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { store } from '../db/store.js';

const router = express.Router();

// ────────────────────────────────────────────────────────────
// GET /api/v1/audit/verify
// Recompute the whole audit hash chain (ADMIN only). Reports whether it is intact, the first break if not, and the
// head { chain_seq, hash } so a future external checkpoint can record it. A hash chain is tamper-EVIDENT: it detects
// edits, deletions and reordering; a cut-off tail or a full rewrite needs that head kept outside the database.
// ────────────────────────────────────────────────────────────
router.get('/verify', authenticate, authorize('ADMIN'), async (req, res) => {
  const verification = await store.verifyAuditChain();
  res.json({ success: true, verification });
});

export default router;
