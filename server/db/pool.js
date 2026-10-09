// server/db/pool.js
// MySQL2 Connection Pool with ACID Transaction Support
// Uses environment variables for configuration

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '3306', 10),
  database:           process.env.DB_NAME     || 'emergency_system',
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASS     || '',
  waitForConnections: true,
  connectionLimit:    20,
  queueLimit:         50,
  // ACID: serializable isolation for resource allocation
  timezone:           '+05:30',
  charset:            'utf8mb4',
});

/**
 * Execute a query within a managed ACID transaction.
 * Automatically commits on success, rolls back on any error.
 * @param {Function} txFn - async (connection) => result
 */
export async function withTransaction(txFn) {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    const result = await txFn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export default pool;
