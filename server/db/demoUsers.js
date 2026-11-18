// server/db/demoUsers.js
// The fictional DEMO accounts, stored exactly as SystemUser rows: bcrypt hashes (cost 10), never plaintext.
// The hashes were computed once with bcryptjs; the demo passwords themselves are documented for the demo only.
//
// Every row is flagged is_demo = 1. Demo accounts are:
//  - seeded only outside production (`npm run db:seed` refuses to insert them when NODE_ENV=production);
//  - REFUSED at login when NODE_ENV=production, wherever they come from (the in-memory store always has them);
//  - reported by a start-up warning when a production server finds any in its store.
// Real accounts are created with `npm run user:create` (scripts/user-create.js).

const ADMIN_HASH = '$2b$10$4U6UYbEaw9W7bZ.v6VAliOxwwNBHsZfEhGvyWQUAEQqbNbVFlbCGK';
const DESK_HASH = '$2b$10$bD7cBAg1qS5CjH6o9YCe6OAbxIJkqJjGGTYZoHYN/KME8U7JasBxm';
const PARAMEDIC_HASH = '$2b$10$1r5UN3HtVoO8Qf.yqLlc9.U7puKV9Hl1G9H/tE8C4uWJQOHgD/f4O';

const desk = (n, username, name) => ({
  user_id: `USER-HSP-${n}`, username, password_hash: DESK_HASH, role: 'HOSPITAL_DESK',
  hospital_id: `H-${n}`, ambulance_id: null, display_name: `${name} — Emergency Desk`
});

export const DEMO_USERS = Object.freeze([
  // Batch 8 (simplified product): Admin, Hospital desk and Fleet logins only. The Operator (DISPATCHER) and Patient demo
  // accounts are gone; their roles stay dormant in the code (server/services/accounts.js ASSIGNABLE_ROLES).
  { user_id: 'USER-ADM-001', username: 'admin', password_hash: ADMIN_HASH, role: 'ADMIN', hospital_id: null, ambulance_id: null, display_name: 'Command Center Admin' },
  desk(101, 'apex_desk', 'Clock Tower Trauma Centre (demo)'),
  desk(102, 'stjude_desk', 'Rajpur Road General (demo)'),
  desk(103, 'fortis_desk', 'Premnagar Heart & Neuro (demo)'),
  desk(104, 'memorial_desk', 'Clement Town Community Clinic (demo)'),
  desk(105, 'maxlife_desk', 'Sahastradhara Emergency Centre (demo)'),
  // Each demo paramedic crews one unit (X4): they may change the status of that unit only.
  { user_id: 'USER-EMS-001', username: 'UNIT-402', password_hash: PARAMEDIC_HASH, role: 'PARAMEDIC', hospital_id: null, ambulance_id: 'AMB-01', display_name: 'Paramedic Unit 402' },
  { user_id: 'USER-EMS-002', username: 'UNIT-601', password_hash: PARAMEDIC_HASH, role: 'PARAMEDIC', hospital_id: null, ambulance_id: 'AMB-04', display_name: 'Paramedic Unit 601' }
].map(user => Object.freeze({ patient_id: null, ...user, is_active: 1, is_demo: 1 })));

/** Fresh mutable copies (the in-memory SystemUser table). */
export function demoUserRows() {
  return DEMO_USERS.map(user => ({ ...user, created_at: new Date().toISOString(), last_login: null }));
}
