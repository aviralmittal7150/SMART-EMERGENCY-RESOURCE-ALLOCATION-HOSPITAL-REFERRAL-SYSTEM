// Runs the Batch 8 P0 hospital-workflow scenario (tests/batch8_hospital.test.js) against the real MySQL test database.
// Skipped, not failed, when MySQL is not configured or reachable (unless REQUIRE_MYSQL_TESTS=true).
process.env.API_TEST_BACKEND = 'mysql';
await import('./batch8_hospital.test.js');
