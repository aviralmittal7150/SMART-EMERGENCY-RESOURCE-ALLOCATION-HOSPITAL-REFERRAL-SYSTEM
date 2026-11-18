// Runs the ambulance live-tracking scenario (tests/tracking_api.test.js) against the real MySQL test database instead of
// the in-memory store, including the restart test. Skipped, not failed, when MySQL is not configured or reachable
// (unless REQUIRE_MYSQL_TESTS=true).
process.env.API_TEST_BACKEND = 'mysql';
await import('./tracking_api.test.js');
