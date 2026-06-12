'use strict';

/**
 * Shared test configuration + helpers.
 *
 * Config is read from environment variables (with sensible defaults) so the
 * suite can be pointed at any greader-compatible server:
 *
 *   GREADER_BASE_URL   e.g. https://freshrss.example.net/api/greader.php  (required to run for real)
 *   GREADER_USER       username / Email
 *   GREADER_PASSWORD   API password (NOT the account password in FreshRSS)
 *   GREADER_FEED_URL   a public, stable RSS feed used for subscribe tests.
 *                      Defaults to the example.org RSS feed.
 *   GREADER_TEST_LABEL prefix for throwaway labels created by write tests,
 *                      to avoid colliding with user data. Default "ContractTest".
 *   GREADER_SKIP_WRITES=1  skip all tests that mutate server state.
 *
 * If GREADER_BASE_URL is unset, the test files will skip themselves with a
 * clear message rather than failing — so `npm test` is always safe to invoke.
 */

const { GreaderClient } = require('./greader-client');

function config() {
  return {
    baseUrl: process.env.GREADER_BASE_URL || '',
    user: process.env.GREADER_USER || '',
    password: process.env.GREADER_PASSWORD || '',
    feedUrl: process.env.GREADER_FEED_URL || 'https://example.org/feed/',
    labelPrefix: process.env.GREADER_TEST_LABEL || 'ContractTest',
    skipWrites: process.env.GREADER_SKIP_WRITES === '1',
    timeoutMs: Number(process.env.GREADER_TIMEOUT_MS || 20000),
  };
}

/** A random, sortable unique suffix to keep throwaway state from colliding. */
function uniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function uniqueLabel(base) {
  return `${base}-${uniqueId()}`;
}

/**
 * Build a client and log in once. Returns { client, cfg }.
 * Throws if BASE_URL/USER/PASSWORD are not configured.
 */
function configuredClient() {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.user || !cfg.password) {
    const missing = [
      !cfg.baseUrl && 'GREADER_BASE_URL',
      !cfg.user && 'GREADER_USER',
      !cfg.password && 'GREADER_PASSWORD',
    ].filter(Boolean).join(', ');
    throw new Error(
      `Cannot build configured client; missing env: ${missing}.\n` +
      `Set them to run the suite against a real server, e.g.:\n` +
      `  GREADER_BASE_URL=https://freshrss.example.net/api/greader.php ` +
      `GREADER_USER=alice GREADER_PASSWORD=secret npm test`
    );
  }
  const client = new GreaderClient({
    baseUrl: cfg.baseUrl,
    user: cfg.user,
    password: cfg.password,
    timeoutMs: cfg.timeoutMs,
  });
  return { client, cfg };
}

/** node:test skip helper for when no server is configured. */
function skipUnlessConfigured(t) {
  const cfg = config();
  if (!cfg.baseUrl || !cfg.user || !cfg.password) {
    t.skip('no GREADER_BASE_URL/GREADER_USER/GREADER_PASSWORD configured');
    return true;
  }
  return false;
}

/** Skip if writes are disabled. */
function skipIfWritesDisabled(t) {
  if (config().skipWrites) {
    t.skip('writes disabled (GREADER_SKIP_WRITES=1)');
    return true;
  }
  return false;
}

module.exports = {
  config,
  configuredClient,
  skipUnlessConfigured,
  skipIfWritesDisabled,
  uniqueId,
  uniqueLabel,
};
