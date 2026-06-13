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
 * ---- Feed ingestion (server-behavior) tests ----
 * These are NOT greader-protocol contract tests. They verify the server
 * actually fetches RSS sources and reflects new/changed items. They need:
 *
 *   GREADER_REFRESH_CMD     shell command that forces the server to refresh
 *                           all feeds (server-proprietary). If unset, the
 *                           suite falls back to the OPML-import refresh trick
 *                           (works on FreshRSS and any server that refreshes
 *                           after a subscription/import).
 *   GREADER_FEED_BIND       bind spec for the bundled RSS feed server.
 *                           Default '127.0.0.1:0' (ephemeral port).
 *   GREADER_FEED_PUBLIC_URL URL the *greader server* can use to reach the
 *                           bundled feed. Must be reachable from the server
 *                           host, not just the test process. If the server is
 *                           on another machine, set this to a public/VPN IP.
 *                           Defaults to http://127.0.0.1:<port> after bind.
 *   GREADER_INGESTION_TIMEOUT_MS  how long to poll for new items after a
 *                           refresh. Default 120000 (2 min).
 *   GREADER_INGESTION_POLL_MS     poll interval. Default 3000.
 *   GREADER_SKIP_INGESTION=1      skip all ingestion tests.
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
    feedUrl: process.env.GREADER_FEED_URL || 'https://hnrss.org/frontpage',
    labelPrefix: process.env.GREADER_TEST_LABEL || 'ContractTest',
    skipWrites: process.env.GREADER_SKIP_WRITES === '1',
    timeoutMs: Number(process.env.GREADER_TIMEOUT_MS || 20000),

    // Feed ingestion tests
    refreshCmd: process.env.GREADER_REFRESH_CMD || '',
    feedBind: process.env.GREADER_FEED_BIND || '0.0.0.0:0',
    // The *host* the server-under-test should use to reach the bundled feed
    // (e.g. 172.17.0.1 when the server runs in Docker and the feed on the
    // host). The actual port is appended at runtime because the bind port is
    // ephemeral by default. For full control set GREADER_FEED_PUBLIC_URL
    // instead (it wins and is used verbatim).
    feedPublicHost: process.env.GREADER_FEED_PUBLIC_HOST || '',
    feedPublicUrl: process.env.GREADER_FEED_PUBLIC_URL || '',
    ingestionTimeoutMs: Number(process.env.GREADER_INGESTION_TIMEOUT_MS || 120000),
    ingestionPollMs: Number(process.env.GREADER_INGESTION_POLL_MS || 3000),
    ingestionRefreshDelayMs: Number(process.env.GREADER_INGESTION_REFRESH_DELAY_MS || 1000),
    skipIngestion: process.env.GREADER_SKIP_INGESTION === '1',
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

/**
 * Resolve the public URL the *server under test* should use to reach the
 * bundled feed, given the actual bound address (host:port) and config.
 *
 * Priority:
 *   1. cfg.feedPublicUrl  — used verbatim (full URL, advanced override).
 *   2. cfg.feedPublicHost — `http://<host>:<boundPort>/feed.xml`
 *   3. derived from the bind address (`http://<bindHost>:<boundPort>/feed.xml`)
 *
 * @param {string} boundAddr  the actual `host:port` the feed server bound to
 * @param {object} cfg        config() object
 */
function resolveFeedPublicUrl(boundAddr, cfg) {
  if (cfg.feedPublicUrl) return cfg.feedPublicUrl;
  const [host, port] = boundAddr.split(':');
  const pubHost = cfg.feedPublicHost || host;
  return `http://${pubHost}:${port}/feed.xml`;
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

/** Skip all feed-ingestion (server-behavior) tests. */
function skipIfIngestionDisabled(t) {
  if (config().skipIngestion) {
    t.skip('ingestion tests disabled (GREADER_SKIP_INGESTION=1)');
    return true;
  }
  return false;
}

module.exports = {
  config,
  configuredClient,
  skipUnlessConfigured,
  skipIfWritesDisabled,
  skipIfIngestionDisabled,
  uniqueId,
  uniqueLabel,
  resolveFeedPublicUrl,
};
