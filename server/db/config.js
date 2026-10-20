// server/db/config.js
// Explicit storage-mode resolution. There is deliberately NO silent fallback: if MySQL mode is
// selected and MySQL cannot be used, startup fails (see server/db/bootstrap.js).
//
//   DB_USE_MEMORY=true   -> in-memory demo store (data is lost on restart; single process only)
//   DB_USE_MEMORY=false  -> MySQL (persistent; requires DB_HOST/DB_NAME/DB_USER/DB_PASS)
//   unset                -> memory in development; a startup ERROR when NODE_ENV=production
//
// Passwords are never logged or included in error messages.

const TRUE = /^(true|1|yes)$/i;
const FALSE = /^(false|0|no)$/i;

export function resolveStorageConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const raw = (env.DB_USE_MEMORY ?? '').trim();

  let mode;
  if (raw === '') {
    if (production) {
      throw new Error('DB_USE_MEMORY must be set explicitly when NODE_ENV=production: "false" for MySQL, or "true" for the non-persistent in-memory demo store.');
    }
    mode = 'memory';
  } else if (TRUE.test(raw)) {
    mode = 'memory';
  } else if (FALSE.test(raw)) {
    mode = 'mysql';
  } else {
    throw new Error(`DB_USE_MEMORY must be "true" or "false" (got "${raw}").`);
  }

  if (mode === 'memory') return { mode, mysql: null, production };

  const missing = ['DB_HOST', 'DB_NAME', 'DB_USER'].filter(key => !(env[key] ?? '').trim());
  if (missing.length) {
    throw new Error(`MySQL mode (DB_USE_MEMORY=false) requires ${missing.join(', ')} to be set. There are no defaults, to avoid connecting as an unintended user or database.`);
  }
  if (production && !(env.DB_PASS ?? '')) {
    throw new Error('MySQL mode in production requires a non-empty DB_PASS.');
  }

  return {
    mode,
    production,
    mysql: {
      host: env.DB_HOST.trim(),
      port: parseInt(env.DB_PORT || '3306', 10),
      database: env.DB_NAME.trim(),
      user: env.DB_USER.trim(),
      password: env.DB_PASS ?? '',
      connectionLimit: parseInt(env.DB_POOL_SIZE || '20', 10)
    }
  };
}

/** Human-readable, secret-free description for startup logs. */
export function describeStorage(config) {
  if (config.mode === 'memory') {
    return 'IN-MEMORY demo store: data is NOT persisted and is lost on restart (single process only).';
  }
  const { host, port, database, user } = config.mysql;
  return `MySQL ${user}@${host}:${port}/${database} (persistent).`;
}
