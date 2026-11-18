// Runs the end-to-end API lifecycle scenario (tests/api_integration.test.js) against the real
// MySQL test database instead of the in-memory store. Skipped, not failed, when MySQL is not
// configured or reachable. See tests/helpers/mysqlTestDb.js.
process.env.API_TEST_BACKEND = 'mysql';
await import('./api_integration.test.js');
