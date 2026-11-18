// Runs the security and scoping scenario (tests/security_scoping.test.js) against the real MySQL test database instead
// of the in-memory store: the parity check for accounts, scoping, referral:status and validation. Skipped, not failed,
// when MySQL is not configured or reachable (unless REQUIRE_MYSQL_TESTS=true). See tests/helpers/mysqlTestDb.js.
process.env.API_TEST_BACKEND = 'mysql';
await import('./security_scoping.test.js');
