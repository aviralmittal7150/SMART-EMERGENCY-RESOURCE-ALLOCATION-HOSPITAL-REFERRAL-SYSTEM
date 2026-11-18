// Runs the portal access-matrix scenario (tests/portal_access.test.js) against the real MySQL test database instead of
// the in-memory store. Skipped, not failed, when MySQL is not configured or reachable (unless REQUIRE_MYSQL_TESTS=true).
process.env.API_TEST_BACKEND = 'mysql';
await import('./portal_access.test.js');
