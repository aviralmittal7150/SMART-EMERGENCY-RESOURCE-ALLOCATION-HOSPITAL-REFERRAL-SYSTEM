// scripts/user-create.js
// Create or update a login account in the MySQL store (SystemUser; review finding X2).
//
//   npm run user:create -- --username <name> --role ADMIN|DISPATCHER|HOSPITAL_DESK|PARAMEDIC|PATIENT
//                          [--hospital <H-id>] [--ambulance <AMB-id>] [--patient <PAT-id>] [--display-name "<text>"] [--inactive]
//
// The password is never a command-line argument (it would show in `ps` and shell history). It is read from the
// ERIS_USER_PASSWORD environment variable, or from standard input: piped (first line), or typed at a terminal with
// echo switched off. It is hashed with bcrypt (cost 12) and never printed.
//
// Safety, as the other database tools (server/db/init.js, server/db/migrate.js): the target comes only from the DB_*
// settings (no defaults; DB_PASS required when NODE_ENV=production), the password of the database is never printed,
// and the database must already be at the current schema (checkSchema: every migration applied), so an account is
// never written into a half-migrated database. An existing username is updated (password, role, scope, name, active
// flag) and stops being a demo account; nothing is ever deleted.

import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { resolveStorageConfig } from '../server/db/config.js';
import { connectForInit } from '../server/db/init.js';
import { checkSchema } from '../server/db/bootstrap.js';

import { BCRYPT_COST } from '../server/services/passwords.js';

export { BCRYPT_COST };
export const MIN_PASSWORD_LENGTH = 12;
// Admin, Hospital desk and Fleet (paramedic) only: the DISPATCHER and PATIENT portals were retired (server/services/accounts.js).
const ROLES = ['ADMIN', 'HOSPITAL_DESK', 'PARAMEDIC'];
const PREFIX = { ADMIN: 'ADM', DISPATCHER: 'DSP', HOSPITAL_DESK: 'HSP', PARAMEDIC: 'EMS', PATIENT: 'PAT' };

export class UserCreateError extends Error {}

/** Validate the account fields; returns the normalised account (without the password). */
export function validateAccount({ username, role, hospitalId = null, ambulanceId = null, patientId = null, displayName = null, active = true }) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{3,80}$/.test(username)) {
    throw new UserCreateError('--username must be 3-80 characters: letters, digits, "_", ".", "@", "-".');
  }
  if (!ROLES.includes(role)) throw new UserCreateError(`--role must be one of ${ROLES.join(', ')}.`);
  if (role === 'HOSPITAL_DESK' && !hospitalId) throw new UserCreateError('A HOSPITAL_DESK account needs --hospital <hospital_id>.');
  if (role === 'PARAMEDIC' && !ambulanceId) throw new UserCreateError('A PARAMEDIC account needs --ambulance <ambulance_id> (the unit they crew).');
  if (role !== 'HOSPITAL_DESK' && hospitalId) throw new UserCreateError('--hospital applies to HOSPITAL_DESK accounts only.');
  if (role !== 'PARAMEDIC' && ambulanceId) throw new UserCreateError('--ambulance applies to PARAMEDIC accounts only.');
  if (role === 'PATIENT' && !patientId) throw new UserCreateError('A PATIENT account needs --patient <patient_id>.');
  if (role !== 'PATIENT' && patientId) throw new UserCreateError('--patient applies to PATIENT accounts only.');
  if (displayName !== null && (typeof displayName !== 'string' || displayName.length > 150)) {
    throw new UserCreateError('--display-name must be at most 150 characters.');
  }
  return { username, role, hospitalId: hospitalId || null, ambulanceId: ambulanceId || null, patientId: patientId || null, displayName: displayName || username, active: Boolean(active) };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new UserCreateError(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  // bcrypt only reads the first 72 bytes: a longer password would silently match any value with the same prefix.
  if (Buffer.byteLength(password, 'utf8') > 72) throw new UserCreateError('The password must be at most 72 bytes (a bcrypt limit).');
  return password;
}

/**
 * Insert or update one account. `conn` is a mysql2 connection to a current-schema database. Returns
 * { user_id, created }. The hash is computed here; the password is not kept or logged.
 */
export async function upsertUser(conn, account, password, { cost = BCRYPT_COST } = {}) {
  const a = validateAccount(account);
  validatePassword(password);
  if (a.hospitalId) {
    const [[hospital]] = await conn.query('SELECT hospital_id FROM Hospital WHERE hospital_id = ?', [a.hospitalId]);
    if (!hospital) throw new UserCreateError(`Hospital ${a.hospitalId} does not exist.`);
  }
  if (a.ambulanceId) {
    const [[ambulance]] = await conn.query('SELECT ambulance_id FROM Ambulance WHERE ambulance_id = ?', [a.ambulanceId]);
    if (!ambulance) throw new UserCreateError(`Ambulance ${a.ambulanceId} does not exist.`);
  }
  if (a.patientId) {
    const [[patient]] = await conn.query('SELECT patient_id FROM Patient WHERE patient_id = ?', [a.patientId]);
    if (!patient) throw new UserCreateError(`Patient ${a.patientId} does not exist.`);
  }
  const hash = await bcrypt.hash(password, cost);
  const [[existing]] = await conn.query('SELECT user_id FROM SystemUser WHERE username = ?', [a.username]);
  if (existing) {
    await conn.query(
      `UPDATE SystemUser SET password_hash = ?, role = ?, hospital_id = ?, ambulance_id = ?, patient_id = ?, display_name = ?, is_active = ?, is_demo = 0, token_version = token_version + 1
       WHERE user_id = ?`,
      [hash, a.role, a.hospitalId, a.ambulanceId, a.patientId, a.displayName, a.active ? 1 : 0, existing.user_id]
    );
    return { user_id: existing.user_id, created: false };
  }
  const userId = `USER-${PREFIX[a.role]}-${randomBytes(4).toString('hex').toUpperCase()}`;
  await conn.query(
    `INSERT INTO SystemUser (user_id, username, password_hash, role, hospital_id, ambulance_id, patient_id, display_name, is_active, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [userId, a.username, hash, a.role, a.hospitalId, a.ambulanceId, a.patientId, a.displayName, a.active ? 1 : 0]
  );
  return { user_id: userId, created: true };
}

/** The password: ERIS_USER_PASSWORD, else stdin (first line when piped; typed without echo at a terminal). */
export async function readPassword({ env = process.env, stdin = process.stdin, stderr = process.stderr } = {}) {
  if (env.ERIS_USER_PASSWORD) return env.ERIS_USER_PASSWORD;
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) text += chunk;
    return text.split(/\r?\n/)[0];
  }
  stderr.write('Password (not echoed): ');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); resolve(value); return; }
        if (ch === '\u0003') { finish(); reject(new UserCreateError('Cancelled.')); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const finish = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

function parseArgs(args) {
  const out = { active: true };
  const flags = { '--username': 'username', '--role': 'role', '--hospital': 'hospitalId', '--ambulance': 'ambulanceId', '--patient': 'patientId', '--display-name': 'displayName' };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--inactive') { out.active = false; continue; }
    if (args[i] === '--password' || args[i].startsWith('--password=')) {
      throw new UserCreateError('Never pass a password on the command line: use ERIS_USER_PASSWORD or standard input.');
    }
    const key = flags[args[i]];
    if (!key) throw new UserCreateError(`Unknown argument ${args[i]}.`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UserCreateError(`${args[i]} needs a value.`);
    out[key] = value;
    i += 1;
  }
  if (out.role) out.role = out.role.toUpperCase();
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  dotenv.config({ quiet: true });
  let conn;
  try {
    const account = validateAccount(parseArgs(process.argv.slice(2)));
    const password = validatePassword(await readPassword());
    const config = resolveStorageConfig({ ...process.env, DB_USE_MEMORY: 'false' });
    const target = `${config.mysql.user}@${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`;
    conn = await connectForInit(config.mysql);
    const problems = await checkSchema(conn);
    if (problems.length) {
      throw new UserCreateError(`The database ${target} is not at the current schema (${problems.join('; ')}). Run \`npm run db:migrate\` first.`);
    }
    const result = await upsertUser(conn, account, password);
    console.log(`${result.created ? 'Created' : 'Updated'} ${account.role} account "${account.username}" (${result.user_id}) on ${target}.`);
  } catch (err) {
    console.error(`[USER] ${err instanceof UserCreateError ? err.message : `Failed: ${err.message}`}`);
    process.exitCode = 1;
  } finally {
    await conn?.end();
  }
}
