// e2e/e2e-server.mjs
// Starts the ERIS server (in-memory store only) with throwaway accounts created for this e2e run.
//
// The demo accounts' passwords are not in any source file the e2e may read, so the e2e makes its own: it sends
// [{ username, password, role, hospital_id, ambulance_id, display_name }] as JSON on this process's STDIN (never argv
// or env), this script bcrypt-hashes each password and replaces the in-memory SystemUser table with those rows, then
// starts server/server.js in the same process (the in-memory store reads that table). Nothing is written to disk and
// no password is printed. The accounts disappear with the process.

import bcrypt from 'bcryptjs';
import { db } from '../server/db/seed.js';

if (String(process.env.DB_USE_MEMORY).trim() !== 'true') {
  console.error('[E2E] e2e-server.mjs runs only with DB_USE_MEMORY=true.');
  process.exit(1);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const accounts = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!Array.isArray(accounts) || accounts.length === 0) {
  console.error('[E2E] No accounts on stdin.');
  process.exit(1);
}

const now = new Date().toISOString();
db.systemUsers = accounts.map((a, i) => ({
  user_id: `E2E-USER-${String(i + 1).padStart(3, '0')}`,
  username: a.username,
  password_hash: bcrypt.hashSync(a.password, 8),
  role: a.role,
  hospital_id: a.hospital_id ?? null,
  ambulance_id: a.ambulance_id ?? null,
  patient_id: a.patient_id ?? null, // a PATIENT account without its patient record is refused at login
  display_name: a.display_name || a.username,
  is_active: 1,
  is_demo: a.is_demo ? 1 : 0, // only where the harness mirrors a demo flag (the sample trip needs a demo-crewed unit)
  token_version: 0, // raised by the store on a password reset, deactivation or role/link change (tokens carry `tv`)
  created_at: now,
  last_login: null
}));
console.log(`[E2E] ${db.systemUsers.length} throwaway accounts created for this run.`);

await import('../server/server.js');
