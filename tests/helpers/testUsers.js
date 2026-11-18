// Test accounts. Since round 2 (item 5) every request loads its account from the store, so a token alone is not
// enough: the account must exist and be active. These helpers register a fictional account and return its token.

import { generateToken } from '../../server/middleware/auth.js';

const row = user => ({
  username: user.user_id, password_hash: '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinval',
  hospital_id: null, ambulance_id: null, display_name: user.user_id, is_active: 1, is_demo: 0, ...user
});

/** Register `user` in a store (memory: its SystemUser array; MySQL: INSERT IGNORE) and return a token for it. */
export async function tokenFor(store, user) {
  const account = row(user);
  if (store.mode === 'mysql') {
    await store.pool.query(
      `INSERT IGNORE INTO SystemUser (user_id, username, password_hash, role, hospital_id, ambulance_id, display_name, is_active, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [account.user_id, account.username, account.password_hash, account.role, account.hospital_id, account.ambulance_id,
        account.display_name, account.is_active, account.is_demo]
    );
  } else {
    store.db.systemUsers ??= [];
    if (!store.db.systemUsers.some(u => u.user_id === account.user_id)) store.db.systemUsers.push(account);
  }
  return generateToken(account);
}

/** The same for the in-memory singleton database used by in-process route tests. */
export function memoryTokenFor(db, user) {
  const account = row(user);
  if (!db.systemUsers.some(u => u.user_id === account.user_id)) db.systemUsers.push(account);
  return generateToken(account);
}
