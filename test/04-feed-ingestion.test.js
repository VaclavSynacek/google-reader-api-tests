'use strict';

/**
 * FEED INGESTION TESTS — server-behavior, NOT greader-protocol contract.
 *
 * The Google Reader API has no "refresh" endpoint, so verifying that the
 * server actually fetches its RSS sources and reflects new/changed items is
 * necessarily out-of-band. These tests:
 *
 *   1. Start a bundled RSS 2.0 feed server whose items we control.
 *   2. Subscribe the greader server to it.
 *   3. Force a refresh via lib/refresh.js (GREADER_REFRESH_CMD, or the
 *      OPML-import fallback for FreshRSS-like servers).
 *   4. Poll stream/contents for that feed and assert new/updated items appear.
 *
 * These will be slow (they wait for the server's refresh + fetch cycle) and
 * depend on the server being able to reach the bundled feed's public URL.
 * They are skipped unless GREADER_BASE_URL is set and GREADER_SKIP_INGESTION
 * is not 1.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { STATE, feed } = require('../lib/greader-client');
const { FeedServer } = require('../lib/feed-server');
const { refreshFeeds } = require('../lib/refresh');
const {
  config, configuredClient, skipUnlessConfigured,
  skipIfIngestionDisabled, uniqueLabel, resolveFeedPublicUrl,
} = require('../lib/test-helpers');

let client, cfg;
let feedServer, feedUrl;

async function feedItemRefs(feedStreamId) {
  const { status, json, text } = await client.streamItemIds(feedStreamId, { n: 100 });
  if (!json || !Array.isArray(json.itemRefs)) {
    process.stderr.write(`[feedItemRefs] status=${status} no itemRefs; body=${text.slice(0,120)}\n`);
    return [];
  }
  return json.itemRefs;
}

async function feedItemCount(feedStreamId) {
  return (await feedItemRefs(feedStreamId)).length;
}

async function feedItems(feedStreamId) {
  const refs = await feedItemRefs(feedStreamId);
  if (refs.length === 0) return [];
  const token = await client.postToken();
  const { json } = await client.streamItemsContents(refs.map((r) => r.id), 'd', token);
  return json && Array.isArray(json.items) ? json.items : [];
}

/**
 * Poll until pred() resolves truthy or timeout. Returns the last value pred
 * returned (so callers can assert meaningfully). Never throws on timeout —
 * the caller asserts the final condition.
 */
async function poll(name, pred, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await pred(); if (last) return last; } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last;
}

before(async () => {
  if (!process.env.GREADER_BASE_URL) return;
  ({ client, cfg } = configuredClient());
  await client.login();
  feedServer = new FeedServer();
  // instrument to see whether the server re-fetches on each refresh
  const _origHandle = feedServer._handle.bind(feedServer);
  feedServer._handle = function (req, res, mp) {
    process.stderr.write(`[FEED-HIT] ${new Date().toISOString()} ${req.method} ${req.url}\n`);
    return _origHandle(req, res, mp);
  };
  const started = await feedServer.start({ bind: cfg.feedBind });
  feedUrl = resolveFeedPublicUrl(`127.0.0.1:${started.port}`, cfg);
});

after(async () => {
  if (feedServer) await feedServer.stop();
});

// ---------------------------------------------------------------------------

test('ingestion: new items in the feed appear after refresh', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  // 1. Seed the feed BEFORE subscribing so the first fetch has something.
  const first = feedServer.addItem({ title: 'Ingestion Seed ' + uniqueLabel('') });
  feedServer.addItem({ title: 'Ingestion Seed 2' });
  t.diagnostic('feed URL: ' + feedUrl);

  // 2. Subscribe the server to our feed. `s` must be `feed/<url>` per the
  // Google Reader wire format (a bare URL is silently ignored by FreshRSS).
  const token = await client.postToken();
  const { status: sub } = await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token });
  assert.equal(sub, 200, 'subscribe must succeed');

  // Best-effort cleanup no matter how the test ends.
  t.after(async () => {
    try {
      const { json } = await client.subscriptionList();
      const found = json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  // 3. Force a refresh.
  const r = await refreshFeeds(client, cfg);
  t.diagnostic('refresh: ' + r.method + ' ok=' + r.ok + ' :: ' + r.detail);
  if (!r.ok) {
    t.skip('refresh mechanism unavailable (' + r.method + ' failed); cannot test ingestion');
    return;
  }

  // 4. Find the feed's stream id, then poll its contents for >= 2 items.
  const feedStreamId = await findFeedStreamId(feedUrl);
  if (!feedStreamId) { t.skip('subscribed feed not found in subscription/list'); return; }

  const seen = await poll(
    'initial items appear',
    async () => (await feedItemCount(feedStreamId)) >= 2,
    { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs },
  );
  assert.ok(seen, `server did not ingest the initial 2 items within ${cfg.ingestionTimeoutMs}ms; refresh may not fetch (or cannot reach ${feedUrl})`);

  // 5. Add a NEW item and refresh again; it must appear.
  feedServer.addItem({ title: 'Late item ' + uniqueLabel('') });
  if (cfg.ingestionRefreshDelayMs > 0) {
    await new Promise((r) => setTimeout(r, cfg.ingestionRefreshDelayMs));
  }
  const r2 = await refreshFeeds(client, cfg);
  t.diagnostic('refresh2: ' + r2.method + ' ok=' + r2.ok);

  const grew = await poll(
    'new item appears',
    async () => (await feedItemCount(feedStreamId)) >= 3,
    { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs },
  );
  assert.ok(grew, 'a newly added feed item did not appear after refresh; server may not be re-fetching on refresh');
});

test('ingestion: an updated item is reflected in the feed', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  const marker = 'ORIGINAL-' + uniqueLabel('');
  const updated = 'CHANGED-' + uniqueLabel('');
  const item = feedServer.addItem({ title: marker, description: '<p>orig</p>' });
  t.diagnostic('feed URL: ' + feedUrl);

  const token = await client.postToken();
  const { status: sub } = await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token });
  assert.equal(sub, 200);
  t.after(async () => {
    try {
      const { json } = await client.subscriptionList();
      const found = json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  // initial refresh + wait for the item to land
  const r = await refreshFeeds(client, cfg);
  t.diagnostic('refresh: ' + r.method + ' ok=' + r.ok);
  if (!r.ok) { t.skip('refresh mechanism unavailable'); return; }

  const feedStreamId = await findFeedStreamId(feedUrl);
  if (!feedStreamId) { t.skip('subscribed feed not found'); return; }

  await poll('original item appears', async () => (await feedItemCount(feedStreamId)) >= 1, {
    timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs,
  });

  // mutate the item in place (same guid) and refresh
  feedServer.updateItem(item.guid, { title: updated });
  if (cfg.ingestionRefreshDelayMs > 0) {
    await new Promise((r) => setTimeout(r, cfg.ingestionRefreshDelayMs));
  }
  const r2 = await refreshFeeds(client, cfg);
  t.diagnostic('refresh2: ' + r2.method + ' ok=' + r2.ok);

  // Poll until the changed title is visible in stream/contents.
  const reflected = await poll('updated title appears', async () => {
    const items = await feedItems(feedStreamId);
    return items.some((it) => it.title && it.title.includes(updated));
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });

  assert.ok(
    reflected,
    `item title was not updated to "${updated}" within ${cfg.ingestionTimeoutMs}ms. ` +
    'Note: some servers cache article bodies by guid and ignore title updates; this is a known compatibility divergence.',
  );
});

// ---- helpers --------------------------------------------------------------

/** Look up the greader stream id (feed/<id>) for a subscribed feed URL. */
async function findFeedStreamId(url) {
  const { json } = await client.subscriptionList();
  const found = json.subscriptions.find((s) => s.url === url);
  return found ? found.id : null;
}
