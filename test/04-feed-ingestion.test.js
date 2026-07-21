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

const { STATE, feed, label } = require('../lib/greader-client');
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

test('ingestion: feed metadata appears in subscriptions and item origins and follows feed changes', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  const initialTitle = 'Metadata Initial ' + uniqueLabel('');
  const changedTitle = 'Metadata Changed ' + uniqueLabel('');
  const initialLink = 'https://example.test/metadata-initial/';
  const changedLink = 'https://example.test/metadata-changed/';
  feedServer.setMetadata({ title: initialTitle, link: initialLink });
  feedServer.addItem({ title: 'Metadata item ' + uniqueLabel('') });

  const token = await client.postToken();
  const { status: sub } = await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token });
  assert.equal(sub, 200, 'subscribe must succeed');
  t.after(async () => {
    try {
      const { json } = await client.subscriptionList();
      const found = json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  const r = await refreshFeeds(client, cfg);
  if (!r.ok) { t.skip('refresh mechanism unavailable'); return; }
  const feedStreamId = await findFeedStreamId(feedUrl);
  assert.ok(feedStreamId, 'subscribed feed must appear in subscription/list');

  const initialSeen = await poll('initial feed metadata appears', async () => {
    const { json } = await client.subscriptionList();
    const found = json.subscriptions.find((s) => s.url === feedUrl);
    return found && found.title === initialTitle && found.htmlUrl === initialLink && found;
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(initialSeen, 'subscription title/htmlUrl must come from RSS channel metadata');
  assert.equal(initialSeen.url, feedUrl, 'subscription feed URL must remain unchanged');

  const originSeen = await poll('item origin metadata appears', async () => {
    const items = await feedItems(feedStreamId);
    return items.find((item) => item.origin && item.origin.title === initialTitle && item.origin.htmlUrl === initialLink);
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(originSeen, 'item origin must expose the discovered feed title and site URL');
  if (originSeen.origin.feedUrl !== undefined) assert.equal(originSeen.origin.feedUrl, feedUrl);

  feedServer.setMetadata({ title: changedTitle, link: changedLink });
  if (cfg.ingestionRefreshDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, cfg.ingestionRefreshDelayMs));
  const r2 = await refreshFeeds(client, cfg);
  assert.ok(r2.ok, 'second refresh must be available');

  const changedSeen = await poll('changed feed metadata appears', async () => {
    const { json } = await client.subscriptionList();
    const found = json.subscriptions.find((s) => s.url === feedUrl);
    return found && found.title === changedTitle && found.htmlUrl === changedLink && found;
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(changedSeen, 'feed-discovered title and htmlUrl must update when channel metadata changes');
});

test('ingestion: an explicit subscription title survives feed refreshes', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  const feedTitle = 'Published title ' + uniqueLabel('');
  const customTitle = 'Custom title ' + uniqueLabel('');
  feedServer.setMetadata({ title: feedTitle, link: 'https://example.test/custom-title/' });
  feedServer.addItem({ title: 'Custom-title item ' + uniqueLabel('') });

  const token = await client.postToken();
  const { status: sub } = await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), t: customTitle, T: token });
  assert.equal(sub, 200, 'subscribe with t must succeed');
  t.after(async () => {
    try {
      const { json } = await client.subscriptionList();
      const found = json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  const r = await refreshFeeds(client, cfg);
  if (!r.ok) { t.skip('refresh mechanism unavailable'); return; }
  const preserved = await poll('custom title survives refresh', async () => {
    const { json } = await client.subscriptionList();
    const found = json.subscriptions.find((s) => s.url === feedUrl);
    return found && found.title === customTitle && found;
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(preserved, 'explicit subscription title must override the title published by the feed');
});

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

test('ingestion: stream contents honors count and oldest-first ordering', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  const base = Date.now() - 3600000;
  feedServer.addItem({ title: 'Ordering oldest ' + uniqueLabel(''), pubDate: new Date(base) });
  feedServer.addItem({ title: 'Ordering middle ' + uniqueLabel(''), pubDate: new Date(base + 60000) });
  feedServer.addItem({ title: 'Ordering newest ' + uniqueLabel(''), pubDate: new Date(base + 120000) });

  const token = await client.postToken();
  const { status: sub } = await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token });
  assert.equal(sub, 200, 'subscribe must succeed');
  t.after(async () => {
    try {
      const { json } = await client.subscriptionList();
      const found = json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  const r = await refreshFeeds(client, cfg);
  if (!r.ok) { t.skip('refresh mechanism unavailable'); return; }
  const feedStreamId = await findFeedStreamId(feedUrl);
  assert.ok(feedStreamId, 'subscribed feed must appear in subscription/list');
  const ingested = await poll('ordered fixture items appear', async () => (
    (await feedItemCount(feedStreamId)) >= 3
  ), { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(ingested, 'server must ingest all three ordering fixture items');

  const refs = await feedItemRefs(feedStreamId);
  const ids = refs.slice(0, 3).map((ref) => ref.id);
  assert.equal(ids.length, 3, 'stream/items/ids must return the three fixture item IDs');
  const hydrateToken = await client.postToken();
  const { status: hydrateStatus, json: hydrated, text: hydrateText } = await client.streamItemsContents(ids, 'd', hydrateToken);
  if (hydrateStatus === 400 && /only json output/i.test(hydrateText)) {
    t.skip('server requires a non-standard output=json parameter for stream/items/contents');
    return;
  }
  assert.equal(hydrateStatus, 200, 'stream/items/contents must accept IDs returned by stream/items/ids');
  assert.ok(hydrated && Array.isArray(hydrated.items), 'hydration must return an items array');
  assert.equal(hydrated.items.length, ids.length, 'hydration must return exactly the requested items');
  for (const item of hydrated.items) assert.match(item.id, /^tag:google\.com,2005:reader\/item\//);

  const { json: few } = await client.streamContents(feedStreamId, { n: 1 });
  if (!few || !Array.isArray(few.items)) {
    t.skip('feed stream/contents does not return { items } (known compatibility difference)');
    return;
  }
  assert.equal(few.items.length, 1, 'n=1 must return exactly one item when the feed has three');

  const { json: oldestFirst } = await client.streamContents(feedStreamId, { n: 3, r: 'o' });
  assert.ok(oldestFirst && Array.isArray(oldestFirst.items), 'feed stream must return an items array');
  assert.equal(oldestFirst.items.length, 3, 'n=3 must return all three fixture items');
  const ts = (item) => Number(item.timestampUsec || (item.published ? item.published * 1e6 : 0));
  for (let i = 1; i < oldestFirst.items.length; i += 1) {
    assert.ok(ts(oldestFirst.items[i]) >= ts(oldestFirst.items[i - 1]), 'r=o timestamps must be non-decreasing');
  }
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

test('unsubscribe deletes the feed\'s items from every stream', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  // 1. Seed the feed with multiple items and subscribe.
  const labelName = uniqueLabel('CleanupLabel');
  feedServer.addItem({ title: 'Cleanup Seed A ' + uniqueLabel('') });
  const starItem = feedServer.addItem({ title: 'Cleanup Seed B ' + uniqueLabel('') });
  feedServer.addItem({ title: 'Cleanup Seed C ' + uniqueLabel('') });
  t.diagnostic('feed URL: ' + feedUrl);

  const token = await client.postToken();
  const { status: sub } = await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token });
  assert.equal(sub, 200, 'subscribe must succeed');

  const r = await refreshFeeds(client, cfg);
  t.diagnostic('refresh: ' + r.method + ' ok=' + r.ok + ' :: ' + r.detail);
  if (!r.ok) { t.skip('refresh mechanism unavailable'); return; }

  const feedStreamId = await findFeedStreamId(feedUrl);
  if (!feedStreamId) { t.skip('subscribed feed not found in subscription/list'); return; }

  // Wait for ingestion of at least 3 items.
  const ingested = await poll(
    'initial items appear',
    async () => (await feedItemCount(feedStreamId)) >= 3,
    { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs },
  );
  assert.ok(ingested, `server did not ingest the initial 3 items within ${cfg.ingestionTimeoutMs}ms`);

  // 2. Capture the item ids, then star one and label another. These mutations
  //    add the items to additional streams (STARRED, LABEL#...) which must
  //    also be cleaned up on unsubscribe.
  const refs = await feedItemRefs(feedStreamId);
  assert.ok(refs.length >= 3, 'expected at least 3 ingested items');
  const ids = refs.map((r) => r.id);
  const starItemId = ids[0];
  const labelItemId = ids[1];

  const { status: starStatus } = await client.editTag({ i: [starItemId], a: [STATE.STARRED], T: token });
  assert.equal(starStatus, 200, 'edit-tag star must succeed');
  const { status: labelStatus } = await client.editTag({ i: [labelItemId], a: [label(labelName)], T: token });
  assert.equal(labelStatus, 200, 'edit-tag label must succeed');

  // 3. Snapshot presence in every stream BEFORE unsubscribe. Skip the rest if
  //    the server doesn't actually expose starred/label streams (some don't).
  const beforeAll = (await feedItemRefs(STATE.READING_LIST)).map((r) => r.id);
  const beforeStarred = (await feedItemRefs(STATE.STARRED)).map((r) => r.id);
  const beforeLabel = (await feedItemRefs(label(labelName))).map((r) => r.id);
  const starExistedBefore = beforeStarred.includes(starItemId);
  const labelExistedBefore = beforeLabel.includes(labelItemId);
  if (!starExistedBefore || !labelExistedBefore) {
    t.skip('server did not expose starred/label stream items; cannot verify cross-stream cleanup');
    return;
  }
  assert.ok(beforeAll.includes(starItemId), 'item must be in reading-list before unsubscribe');

  // 4. Unsubscribe. Best-effort cleanup happens in t.after regardless.
  const { status: unsub } = await client.subscriptionEdit({ ac: 'unsubscribe', s: feedStreamId, T: token });
  assert.equal(unsub, 200, 'unsubscribe must return 200');

  // 5. Poll until the items disappear from every stream (or timeout).
  const cleanupOk = await poll(
    'items removed from all streams',
    async () => {
      const feedLeft = await feedItemCount(feedStreamId);
      if (feedLeft > 0) return false;
      const allIds = new Set((await feedItemRefs(STATE.READING_LIST)).map((r) => r.id));
      if (ids.some((id) => allIds.has(id))) return false;
      const starredIds = new Set((await feedItemRefs(STATE.STARRED)).map((r) => r.id));
      if (ids.some((id) => starredIds.has(id))) return false;
      const labelIds = new Set((await feedItemRefs(label(labelName))).map((r) => r.id));
      if (ids.some((id) => labelIds.has(id))) return false;
      return true;
    },
    { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs },
  );

  // 6. Subscription itself must also be gone.
  const { json: subsAfter } = await client.subscriptionList();
  const stillSubscribed = (subsAfter.subscriptions || []).some((s) => s.id === feedStreamId || s.url === feedUrl);
  assert.equal(stillSubscribed, false, 'subscription must be removed from subscription/list');

  assert.ok(
    cleanupOk,
    `unsubscribed feed\'s items were not removed from every stream within ${cfg.ingestionTimeoutMs}ms. ` +
    'A clean unsubscribe must delete items from the feed stream, the global reading-list, starred, and any label.',
  );
});

// ---- helpers --------------------------------------------------------------

/** Look up the greader stream id (feed/<id>) for a subscribed feed URL. */
async function findFeedStreamId(url) {
  const { json } = await client.subscriptionList();
  const found = json.subscriptions.find((s) => s.url === url);
  return found ? found.id : null;
}