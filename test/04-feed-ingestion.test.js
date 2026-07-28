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

test('ingestion: stream queries honor count, ordering, hydration, ot and nt', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  const base = (Math.floor(Date.now() / 1000) - 3600) * 1000;
  for (let i = 0; i < 8; i += 1) {
    feedServer.addItem({ title: `Ordering item ${i} ` + uniqueLabel(''), pubDate: new Date(base + (i * 60000)) });
  }

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
    (await feedItemCount(feedStreamId)) >= 8
  ), { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(ingested, 'server must ingest all eight ordering fixture items');

  const refs = await feedItemRefs(feedStreamId);
  const ids = refs.slice(0, 3).map((ref) => ref.id);
  const hydrateToken = await client.postToken();
  const { status: hydrateStatus, json: hydrated, text: hydrateText } = await client.streamItemsContents(
    [...ids, '999999999999999999'], 'd', hydrateToken
  );
  if (hydrateStatus === 400 && /only json output/i.test(hydrateText)) {
    t.skip('server requires a non-standard output=json parameter for stream/items/contents');
    return;
  }
  assert.equal(hydrateStatus, 200, 'stream/items/contents must accept IDs returned by stream/items/ids');
  assert.ok(hydrated && Array.isArray(hydrated.items), 'hydration must return an items array');
  assert.equal(hydrated.items.length, ids.length, 'hydration must return existing requested items and ignore a missing ID');
  for (const item of hydrated.items) assert.match(item.id, /^tag:google\.com,2005:reader\/item\//);

  const { json: few } = await client.streamContents(feedStreamId, { n: 1 });
  assert.ok(few && Array.isArray(few.items), 'feed stream must return an items array');
  assert.equal(few.items.length, 1, 'n=1 must return exactly one item');

  const { json: oldestFirst } = await client.streamContents(feedStreamId, { n: 8, r: 'o' });
  assert.ok(oldestFirst && Array.isArray(oldestFirst.items), 'feed stream must return an items array');
  assert.equal(oldestFirst.items.length, 8, 'n=8 must return all fixture items');
  const ts = (item) => Number(item.timestampUsec || (item.published ? item.published * 1e6 : 0));
  for (let i = 1; i < oldestFirst.items.length; i += 1) {
    assert.ok(ts(oldestFirst.items[i]) >= ts(oldestFirst.items[i - 1]), 'r=o timestamps must be non-decreasing');
  }

  const pagedItems = [];
  let contentsContinuation;
  for (let page = 0; page < 4 && pagedItems.length < 8; page += 1) {
    const { json: result } = await client.streamContents(feedStreamId, {
      n: 3,
      r: 'o',
      ...(contentsContinuation ? { c: contentsContinuation } : {}),
    });
    assert.ok(result && Array.isArray(result.items), 'paginated stream/contents must return items');
    assert.ok(result.items.length <= 3, 'a continuation page must honor n');
    assert.ok(!result.items.some((item) => pagedItems.some((old) => old.id === item.id)), 'continuation pages must not repeat items');
    pagedItems.push(...result.items);
    contentsContinuation = result.continuation;
    if (pagedItems.length < 8) assert.ok(contentsContinuation, 'a full page with more items must return continuation');
  }
  assert.deepEqual(
    pagedItems.map((item) => item.id),
    oldestFirst.items.map((item) => item.id),
    'stream/contents continuation pages must reproduce the complete ordered stream',
  );
  assert.equal(contentsContinuation, undefined, 'the final partial stream/contents page must not return continuation');

  const pagedRefIds = [];
  let idsContinuation;
  for (let page = 0; page < 4 && pagedRefIds.length < 8; page += 1) {
    const result = await client.streamItemIds(feedStreamId, {
      n: 3,
      r: 'd',
      ...(idsContinuation ? { c: idsContinuation } : {}),
    });
    assert.equal(result.status, 200);
    const pageIds = result.json.itemRefs.map((ref) => ref.id);
    assert.ok(pageIds.length <= 3, 'an item ID continuation page must honor n');
    assert.ok(!pageIds.some((id) => pagedRefIds.includes(id)), 'item ID continuation pages must not repeat IDs');
    pagedRefIds.push(...pageIds);
    idsContinuation = result.json.continuation;
    if (pagedRefIds.length < 8) assert.ok(idsContinuation, 'a full item ID page with more items must return continuation');
  }
  assert.equal(pagedRefIds.length, 8, 'stream/items/ids continuation pages must return the complete stream');
  assert.equal(new Set(pagedRefIds).size, 8, 'stream/items/ids continuation pages must return each item once');
  assert.equal(idsContinuation, undefined, 'the final partial item ID page must not return continuation');

  // Both filters are strict. These queries deliberately place all matches
  // beyond the first five rows in query order, catching implementations that
  // fetch a fixed oversample window and filter afterward.
  const nt = Math.floor((base + 120000) / 1000);
  const olderRefs = await client.streamItemIds(feedStreamId, { n: 1, nt });
  assert.equal(olderRefs.status, 200);
  assert.equal(olderRefs.json.itemRefs.length, 1, 'nt must still fill n when older matches exist');
  const olderHydrated = await client.streamItemsContents([olderRefs.json.itemRefs[0].id], 'd', hydrateToken);
  assert.ok(ts(olderHydrated.json.items[0]) < nt * 1e6, 'nt must exclude the boundary and newer items');

  const ot = Math.floor((base + 240000) / 1000);
  const { json: newerOldestFirst } = await client.streamContents(feedStreamId, { n: 1, r: 'o', ot });
  assert.equal(newerOldestFirst.items.length, 1, 'ot must still fill n when newer matches exist');
  assert.ok(ts(newerOldestFirst.items[0]) > ot * 1e6, 'ot must exclude the boundary and older items');
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

  const original = await poll('original item appears', async () => (
    (await feedItems(feedStreamId)).find((it) => it.title && it.title.includes(marker))
  ), { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(original, 'original item must appear before it can be updated');

  // User-managed state must survive a crawler update of the same item.
  const stateLabel = label(uniqueLabel('UpdateState'));
  const stateUpdate = await client.editTag({
    i: [original.id], a: [STATE.READ, STATE.STARRED, stateLabel], T: token,
  });
  assert.equal(stateUpdate.status, 200, 'setting item state before refresh must succeed');

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
    return items.find((it) => it.title && it.title.includes(updated));
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });

  assert.ok(
    reflected,
    `item title was not updated to "${updated}" within ${cfg.ingestionTimeoutMs}ms. ` +
    'Note: some servers cache article bodies by guid and ignore title updates; this is a known compatibility divergence.',
  );
  assert.ok(reflected.categories.includes(STATE.READ), 'read state must survive an update of the same feed item');
  assert.ok(reflected.categories.includes(STATE.STARRED), 'starred state must survive an update of the same feed item');
  assert.ok(reflected.categories.includes(stateLabel), 'labels must survive an update of the same feed item');
});

test('ingestion: item labels are isolated, visible, renameable and disableable', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  feedServer.addItem({ title: 'Isolation target ' + uniqueLabel('') });
  feedServer.addItem({ title: 'Isolation control ' + uniqueLabel('') });
  const token = await client.postToken();
  assert.equal((await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token })).status, 200);
  t.after(async () => {
    try {
      const found = (await client.subscriptionList()).json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  const refresh = await refreshFeeds(client, cfg);
  if (!refresh.ok) { t.skip('refresh mechanism unavailable'); return; }
  const feedStreamId = await findFeedStreamId(feedUrl);
  const ready = await poll('isolation items appear', async () => (await feedItems(feedStreamId)).length >= 2, {
    timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs,
  });
  assert.ok(ready, 'both isolation items must be ingested');
  const [target, control] = await feedItems(feedStreamId);
  const isolatedLabel = label(uniqueLabel('Isolation'));
  assert.equal((await client.editTag({
    i: [target.id], a: [STATE.READ, STATE.STARRED, isolatedLabel], T: token,
  })).status, 200);

  const hydrated = await client.streamItemsContents([target.id, control.id], 'd', token);
  const changed = hydrated.json.items.find((item) => item.id === target.id);
  const unchanged = hydrated.json.items.find((item) => item.id === control.id);
  assert.ok(changed.categories.includes(STATE.READ));
  assert.ok(changed.categories.includes(STATE.STARRED));
  assert.ok(changed.categories.includes(isolatedLabel));
  assert.ok(!unchanged.categories.includes(STATE.READ), 'editing one item must not mark another item read');
  assert.ok(!unchanged.categories.includes(STATE.STARRED), 'editing one item must not star another item');
  assert.ok(!unchanged.categories.includes(isolatedLabel), 'editing one item must not label another item');
  assert.ok((await client.tagList()).json.tags.some((tag) => tag.id === isolatedLabel), 'item label must appear in tag/list');

  const renamedLabel = label(uniqueLabel('IsolationRenamed'));
  assert.equal((await client.renameTag({ s: isolatedLabel, dest: renamedLabel, T: token })).status, 200);
  let renamed = await client.streamItemsContents([target.id, control.id], 'd', token);
  const renamedTarget = renamed.json.items.find((item) => item.id === target.id);
  const renamedControl = renamed.json.items.find((item) => item.id === control.id);
  assert.ok(renamedTarget.categories.includes(renamedLabel), 'rename-tag must rename an item label');
  assert.ok(!renamedTarget.categories.includes(isolatedLabel), 'rename-tag must remove the old item label');
  assert.ok(!renamedControl.categories.includes(renamedLabel), 'rename-tag must not label unrelated items');

  assert.equal((await client.disableTag({ s: [renamedLabel], T: token })).status, 200);
  renamed = await client.streamItemsContents([target.id], 'd', token);
  assert.ok(!renamed.json.items[0].categories.includes(renamedLabel), 'disable-tag must remove the label from items');
  assert.ok(!(await client.tagList()).json.tags.some((tag) => tag.id === renamedLabel), 'disabled item label must disappear from tag/list');
});

test('ingestion: item endpoints accept decimal, tagged hexadecimal, and bare hexadecimal ids', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  for (let i = 0; i < 3; i += 1) {
    feedServer.addItem({ title: `ID format item ${i} ` + uniqueLabel('') });
  }
  const token = await client.postToken();
  assert.equal((await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token })).status, 200);
  t.after(async () => {
    try {
      const found = (await client.subscriptionList()).json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  const refresh = await refreshFeeds(client, cfg);
  if (!refresh.ok) { t.skip('refresh mechanism unavailable'); return; }
  const feedStreamId = await findFeedStreamId(feedUrl);
  const ready = await poll('ID format items appear', async () => (await feedItems(feedStreamId)).length >= 3, {
    timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs,
  });
  assert.ok(ready, 'three ID format fixtures must be ingested');

  const items = (await feedItems(feedStreamId)).slice(0, 3);
  const taggedIds = items.map((item) => item.id);
  const hexIds = taggedIds.map((id) => id.slice(id.lastIndexOf('/') + 1));
  const decimalIds = hexIds.map((hex) => BigInt('0x' + hex).toString(10));
  const formats = [decimalIds[0], taggedIds[1], hexIds[2]];
  const formatNames = ['bare decimal', 'tagged hexadecimal', 'bare hexadecimal'];

  for (let i = 0; i < formats.length; i += 1) {
    const hydrated = await client.streamItemsContents([formats[i]], 'd', token);
    assert.equal(hydrated.status, 200, `${formatNames[i]} hydration must succeed`);
    assert.deepEqual(
      hydrated.json.items.map((item) => item.id),
      [taggedIds[i]],
      `${formatNames[i]} must hydrate the corresponding item`,
    );
    assert.equal((await client.editTag({ i: [formats[i]], a: [STATE.READ], T: token })).status, 200);
  }

  const after = await client.streamItemsContents(taggedIds, 'd', token);
  for (let i = 0; i < taggedIds.length; i += 1) {
    const item = after.json.items.find((candidate) => candidate.id === taggedIds[i]);
    assert.ok(item.categories.includes(STATE.READ), `${formatNames[i]} must identify the item for edit-tag`);
  }
});

test('ingestion: unread-count follows item state transitions', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  const base = (Math.floor(Date.now() / 1000) - 1800) * 1000;
  for (let i = 0; i < 3; i += 1) {
    feedServer.addItem({ title: `Unread item ${i} ` + uniqueLabel(''), pubDate: new Date(base + (i * 60000)) });
  }
  const token = await client.postToken();
  assert.equal((await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token })).status, 200);
  t.after(async () => {
    try {
      const found = (await client.subscriptionList()).json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  const refresh = await refreshFeeds(client, cfg);
  if (!refresh.ok) { t.skip('refresh mechanism unavailable'); return; }
  const feedStreamId = await findFeedStreamId(feedUrl);
  const ready = await poll('unread fixtures appear', async () => (await feedItems(feedStreamId)).length >= 3, {
    timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs,
  });
  assert.ok(ready, 'three unread fixtures must be ingested');
  const items = await feedItems(feedStreamId);
  const newest = items.reduce((a, b) => Number(a.timestampUsec) > Number(b.timestampUsec) ? a : b);
  const remainingNewest = String(Math.max(...items.filter((item) => item.id !== newest.id).map((item) => Number(item.timestampUsec))));

  const initial = (await client.unreadCount()).json.unreadcounts.find((entry) => entry.id === feedStreamId);
  assert.equal(initial.count, 3);
  assert.equal(String(initial.newestItemTimestampUsec), String(newest.timestampUsec));

  assert.equal((await client.editTag({ i: [newest.id], a: [STATE.READ], T: token })).status, 200);
  const reduced = await poll('unread count decreases', async () => {
    const entry = (await client.unreadCount()).json.unreadcounts.find((value) => value.id === feedStreamId);
    return entry && entry.count === 2 && entry;
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(reduced, 'marking one item read must reduce its feed unread count');
  assert.equal(String(reduced.newestItemTimestampUsec), remainingNewest);

  const canonicalId = (value) => {
    const text = typeof value === 'string' ? value : value.id;
    const raw = text.includes('/') ? BigInt('0x' + text.slice(text.lastIndexOf('/') + 1)) : BigInt(text);
    return BigInt.asUintN(64, raw).toString(10);
  };
  const fixtureIds = new Set(items.map(canonicalId));
  const allIds = (await client.streamItemIds(feedStreamId, { n: 10 })).json.itemRefs
    .map((ref) => canonicalId(ref.id)).filter((id) => fixtureIds.has(id));
  const unreadIds = (await client.streamItemIds(feedStreamId, { n: 10, xt: STATE.READ })).json.itemRefs
    .map((ref) => canonicalId(ref.id)).filter((id) => fixtureIds.has(id));
  const readByItIds = (await client.streamItemIds(feedStreamId, { n: 10, it: STATE.READ })).json.itemRefs
    .map((ref) => canonicalId(ref.id)).filter((id) => fixtureIds.has(id));
  const readStreamIds = (await client.streamItemIds(STATE.READ, {
    n: 1000,
    ot: Math.floor(base / 1000) - 1,
  })).json.itemRefs.map((ref) => canonicalId(ref.id)).filter((id) => fixtureIds.has(id));
  assert.deepEqual(new Set(allIds), fixtureIds, 'feed stream must expose every fixture item');
  assert.deepEqual(new Set(unreadIds), new Set(items.filter((item) => item.id !== newest.id).map(canonicalId)));
  assert.deepEqual(readByItIds, [canonicalId(newest)], 'it=read must return only read items');
  assert.deepEqual(readStreamIds, [canonicalId(newest)], 'the canonical read stream must return only read items');
  assert.deepEqual(new Set([...unreadIds, ...readByItIds]), fixtureIds, 'read and unread IDs must partition the feed');

  assert.equal((await client.editTag({ i: [newest.id], r: [STATE.READ], T: token })).status, 200);
  const restored = await poll('unread count is restored', async () => {
    const entry = (await client.unreadCount()).json.unreadcounts.find((value) => value.id === feedStreamId);
    return entry && entry.count === 3 && entry;
  }, { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(restored, 'removing read state must restore the feed unread count');
  assert.equal(String(restored.newestItemTimestampUsec), String(newest.timestampUsec));
});

test('ingestion: mark-all-as-read respects label scope and cutoff', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;

  const base = (Math.floor(Date.now() / 1000) - 1200) * 1000;
  const oldTitle = 'Mark old labelled ' + uniqueLabel('');
  const newTitle = 'Mark new labelled ' + uniqueLabel('');
  const controlTitle = 'Mark control ' + uniqueLabel('');
  feedServer.addItem({ title: oldTitle, pubDate: new Date(base) });
  feedServer.addItem({ title: newTitle, pubDate: new Date(base + 120000) });
  feedServer.addItem({ title: controlTitle, pubDate: new Date(base) });
  const token = await client.postToken();
  assert.equal((await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token })).status, 200);
  t.after(async () => {
    try {
      const found = (await client.subscriptionList()).json.subscriptions.find((s) => s.url === feedUrl);
      if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
    } catch { /* ignore */ }
    feedServer.reset();
  });

  const refresh = await refreshFeeds(client, cfg);
  if (!refresh.ok) { t.skip('refresh mechanism unavailable'); return; }
  const feedStreamId = await findFeedStreamId(feedUrl);
  const ready = await poll('mark-all fixtures appear', async () => (await feedItems(feedStreamId)).length >= 3, {
    timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs,
  });
  assert.ok(ready, 'all mark-all fixtures must be ingested');
  const items = await feedItems(feedStreamId);
  const oldTarget = items.find((item) => item.title === oldTitle);
  const newTarget = items.find((item) => item.title === newTitle);
  const control = items.find((item) => item.title === controlTitle);
  const targetLabel = label(uniqueLabel('MarkScope'));
  assert.equal((await client.editTag({ i: [oldTarget.id, newTarget.id], a: [targetLabel], T: token })).status, 200);
  const cutoffNs = (BigInt(base + 60000) * 1000000n).toString();
  assert.equal((await client.markAllAsRead({ s: targetLabel, ts: cutoffNs, T: token })).status, 200);

  const hydrated = await client.streamItemsContents([oldTarget.id, newTarget.id, control.id], 'd', token);
  const oldAfter = hydrated.json.items.find((item) => item.id === oldTarget.id);
  const newAfter = hydrated.json.items.find((item) => item.id === newTarget.id);
  const controlAfter = hydrated.json.items.find((item) => item.id === control.id);
  assert.ok(oldAfter.categories.includes(STATE.READ), 'labelled item at or before cutoff must become read');
  assert.ok(!newAfter.categories.includes(STATE.READ), 'labelled item newer than cutoff must remain unread');
  assert.ok(!controlAfter.categories.includes(STATE.READ), 'marking a label read must not affect an unlabelled item');
});

test('ingestion: feed-scoped mark-all does not affect another feed', { timeout: 240000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfIngestionDisabled(t)) return;
  if (cfg.feedPublicUrl) { t.skip('a fixed GREADER_FEED_PUBLIC_URL cannot expose a second dynamic feed'); return; }

  const second = new FeedServer();
  const started = await second.start({ bind: cfg.feedBind });
  const secondUrl = resolveFeedPublicUrl(`127.0.0.1:${started.port}`, cfg);
  feedServer.addItem({ title: 'First scoped feed ' + uniqueLabel('') });
  second.addItem({ title: 'Second scoped feed ' + uniqueLabel('') });
  const token = await client.postToken();
  assert.equal((await client.subscriptionEdit({ ac: 'subscribe', s: feed(feedUrl), T: token })).status, 200);
  assert.equal((await client.subscriptionEdit({ ac: 'subscribe', s: feed(secondUrl), T: token })).status, 200);
  t.after(async () => {
    try {
      const subscriptions = (await client.subscriptionList()).json.subscriptions;
      for (const url of [feedUrl, secondUrl]) {
        const found = subscriptions.find((s) => s.url === url);
        if (found) await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: await client.postToken() });
      }
    } catch { /* ignore */ }
    feedServer.reset();
    await second.stop();
  });

  const refresh = await refreshFeeds(client, cfg);
  if (!refresh.ok) { t.skip('refresh mechanism unavailable'); return; }
  const firstStream = await findFeedStreamId(feedUrl);
  const secondStream = await findFeedStreamId(secondUrl);
  const ready = await poll('both scoped feeds appear', async () => (
    (await feedItems(firstStream)).length >= 1 && (await feedItems(secondStream)).length >= 1
  ), { timeoutMs: cfg.ingestionTimeoutMs, pollMs: cfg.ingestionPollMs });
  assert.ok(ready, 'both feeds must have an item');
  const firstItem = (await feedItems(firstStream))[0];
  const secondItem = (await feedItems(secondStream))[0];
  const cutoffNs = ((BigInt(firstItem.timestampUsec) + 1000000n) * 1000n).toString();
  assert.equal((await client.markAllAsRead({ s: firstStream, ts: cutoffNs, T: token })).status, 200);

  const hydrated = await client.streamItemsContents([firstItem.id, secondItem.id], 'd', token);
  const firstAfter = hydrated.json.items.find((item) => item.id === firstItem.id);
  const secondAfter = hydrated.json.items.find((item) => item.id === secondItem.id);
  assert.ok(firstAfter.categories.includes(STATE.READ), 'item in the selected feed must become read');
  assert.ok(!secondAfter.categories.includes(STATE.READ), 'item in another feed must remain unread');
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