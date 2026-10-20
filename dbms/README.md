# 💾 Database Management Systems (DBMS) Mode — Project Explorer Directory

This directory organizes all codebase files related to **Database Management Systems (DBMS) concepts**, allowing examiners, evaluators, and developers to explore the database architecture directly from the project explorer.

---

## 📂 DBMS File Directory Map

| File in `dbms/` | Original File Link | DBMS Principle Implemented | Assigned Lead |
| :--- | :--- | :--- | :--- |
| [`01_relational_schema_10_tables.sql`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/server/db/schema.sql) | `server/db/schema.sql` | **10-Table 3NF Normalized Schema**<br>Foreign keys, composite indexes, ENUM types, integrity constraints | 🧠 Devansh |
| [`02_database_seed_data.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/server/db/seed.js) | `server/db/seed.js` | **Mock Storage & In-Memory Relational Engine**<br>Referential joins, audit logging hooks, transaction emulation | 🧠 Devansh |
| [`03_mysql_connection_pool.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/server/db/pool.js) | `server/db/pool.js` | **Connection Pooling & Query Wrapper**<br>Thread-safe connection reuse, parameterized queries (SQLi prevention) | 🧠 Devansh |
| [`04_sha256_immutable_audit_ledger.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/js/audit_ledger.js) | `js/audit_ledger.js` | **Cryptographic Tamper-Evident Ledger**<br>Blockchain-style SHA-256 hash chaining for medico-legal audit trails | 📊 Om |
| [`05_acid_transactions_referral_routes.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/server/routes/referrals.js) | `server/routes/referrals.js` | **ACID Transactions & Row-Level Locking**<br>`SELECT ... FOR UPDATE`, atomic commit on accept, rollback on timeout | ⚡ Saurabh |
| [`06_aggregate_analytics_queries.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/server/routes/analytics.js) | `server/routes/analytics.js` | **Analytical Queries & SQL Aggregations**<br>`COUNT`, `AVG`, `SUM`, time-bucketed hourly demand distribution | 📊 Om |
| [`07_audit_ledger_test.js`](file:///Users/aviralmittal/Downloads/SMART%20EMERGENCY%20RESOURCE%20ALLOCATION%20&%20HOSPITAL%20REFERRAL%20SYSTEM/tests/audit_ledger.test.js) | `tests/audit_ledger.test.js` | **Audit Ledger Verification Suite**<br>Cryptographic chain validation, tampering detection, CSV export | 📊 Om |

---

## 🧪 How to Run DBMS Test Suite

```bash
# Run DBMS & audit ledger verification tests
npm run test:audit
npm test tests/phase2_backend.test.js
```
