// server/services/passwords.js
// One bcrypt cost for every password hash the application writes (scripts/user-create.js), and a dummy hash at that
// SAME cost for logins with an unknown username, so an unknown user costs as much time as a real one (round 2, item 6).
// The fictional demo accounts keep their published cost-10 hashes (server/db/demoUsers.js); they are refused in
// production anyway.

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

export const BCRYPT_COST = 12;

let dummy = null;
/** A hash (BCRYPT_COST) of a random value nobody knows; computed once per process, on first use. */
export function dummyHash() {
  dummy ??= bcrypt.hash(randomBytes(24).toString('hex'), BCRYPT_COST);
  return dummy;
}
