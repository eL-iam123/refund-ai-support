/**
 * Test-wide environment.
 *
 * `ADMIN_API_SECRET` is required in production and the server refuses to start
 * without it, which is the behaviour we want. Tests read the environment
 * directly in a few places, so the value is supplied here once rather than
 * repeated in each file - and set with `process.env` rather than `test.env` in
 * the vitest config, which would outrank the operator's real `.env` and make the
 * opt-in live suite call the wrong provider.
 */

process.env.ADMIN_API_SECRET ??= 'test-secret-not-used-anywhere-32-chars-min';
