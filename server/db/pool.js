// server/db/pool.js
// MySQL2 connection-pool factory with an explicit lifecycle (no import-time side effects).
// The caller owns the pool and must call pool.end() on shutdown.

import mysql from 'mysql2/promise';

/**
 * @param {{host:string, port:number, database:string, user:string, password:string, connectionLimit?:number}} cfg
 */
export function createPool(cfg) {
  const pool = mysql.createPool({
    host:               cfg.host,
    port:               cfg.port,
    database:           cfg.database,
    user:               cfg.user,
    password:           cfg.password,
    waitForConnections: true,
    connectionLimit:    cfg.connectionLimit || 20,
    queueLimit:         0,
    charset:            'utf8mb4',
    // DECIMAL columns (coordinates, rates) come back as numbers, matching the in-memory shapes.
    decimalNumbers:     true,
    // Dates are exchanged as UTC; each connection is pinned to UTC below so TIMESTAMP values
    // are not shifted by the server's local time zone.
    timezone:           'Z',
    enableKeepAlive:    true
  });

  pool.pool.on('connection', connection => {
    connection.query("SET time_zone = '+00:00'");
    // Bound row-lock waits (MySQL default is 50s): contention fails fast with errno 1205.
    connection.query('SET SESSION innodb_lock_wait_timeout = 10');
  });
  return pool;
}

/** Run `work(conn)` in a transaction: commit on success, roll back on any error. */
export async function withTransaction(pool, work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection may already be gone */ }
    throw err;
  } finally {
    conn.release();
  }
}
