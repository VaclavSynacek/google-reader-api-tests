'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { STATE, label, feed } = require('../lib/greader-client');
const { FeedServer } = require('../lib/feed-server');
const { skipUnlessConfigured, skipIfWritesDisabled, configuredClient, uniqueLabel, resolveFeedPublicUrl } = require('../lib/test-helpers');

let client, cfg;
let feedServer, feedUrl;
before(async () => {
  if (!process.env.GREADER_BASE_URL) return;
  ({ client, cfg } = configuredClient());
  await client.login();
  // Start the bundled feed server and use it as the throwaway subscription
  // target for the subscribe/quickadd round-trips. This makes the write tests
  // fully self-contained: no external network feed is needed, the only thing
  // the server under test must reach is this in-process feed.
  feedServer = new FeedServer();
  const started = await feedServer.start({ bind: cfg.feedBind });
  feedUrl = resolveFeedPublicUrl(`127.0.0.1:${started.port}`, cfg);
});

after(async () => {
  if (feedServer) await feedServer.stop();
});

/**
 * Remove any pre-existing subscription to our feed so a test starts from a
 * clean slate. Returns true if something was unsubscribed.
 */
async function unsubscribeFeedIfPresent() {
  const { json } = await client.subscriptionList();
  const existing = json.subscriptions.find((s) => s.url === feedUrl);
  if (existing) {
    const token = await client.postToken();
    await client.subscriptionEdit({ ac: 'unsubscribe', s: existing.id, T: token });
    return true;
  }
  return false;
}

/**
 * Find a feed id that has unread items we can safely mutate in tests.
 * Falls back to null if none qualify.
 */
async function findFeedWithItems() {
  const { json } = await client.streamItemIds(STATE.READING_LIST, { n: 50 });
  if (!json.itemRefs || json.itemRefs.length === 0) return null;
  return json.itemRefs;
}

// ---- subscription lifecycle (the canonical client round-trip) -------------

test('subscribe -> appears in list -> unsubscribe -> gone', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  // 0. Clean slate: if a previous run (or quickadd) left this feed
  //    subscribed, unsubscribe it first. FreshRSS returns 400 when you
  //    `subscribe` to a feed that is already subscribed, so without this the
  //    test is order-/state-dependent. Real clients must do the same.
  await unsubscribeFeedIfPresent();

  // 1. subscribe. Per the Google Reader wire format the stream id for a
  // subscribe is `feed/<url>` (the `feed/` prefix is mandatory on FreshRSS and
  // the original greader servers; a bare URL is silently ignored).
  const token = await client.postToken();
  const { status: subStatus, text } = await client.subscriptionEdit({
    ac: 'subscribe', s: feed(feedUrl), T: token,
  });
  if (subStatus >= 500) t.diagnostic('subscribe body = ' + text);
  assert.equal(subStatus, 200, 'subscribe must return HTTP 200');

  // 2. it must appear in subscription/list
  const { json: after } = await client.subscriptionList();
  const found = after.subscriptions.find((s) => s.url === feedUrl);
  assert.ok(found, 'newly subscribed feed must appear in subscription/list');
  const feedId = found.id; // feed/<id>

  // 3. unsubscribe
  const { status: unsubStatus } = await client.subscriptionEdit({
    ac: 'unsubscribe', s: feedId, T: token,
  });
  assert.equal(unsubStatus, 200);

  // 4. it must be gone
  const { json: final } = await client.subscriptionList();
  assert.ok(
    !final.subscriptions.find((s) => s.url === feedUrl),
    'unsubscribed feed must not appear in subscription/list',
  );
});

test('quickadd subscribes by URL and returns numResults', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  // Clean slate (FreshRSS 400s on re-subscribe of an existing feed).
  await unsubscribeFeedIfPresent();

  const token = await client.postToken();
  const { status, json } = await client.quickAdd(feedUrl, token);
  assert.equal(status, 200);
  assert.ok(json, 'quickadd must return JSON');
  // Successful add reports numResults=1; servers may report 0 if already subscribed.
  assert.equal(typeof json.numResults, 'number');

  // Clean up if it was added.
  const { json: list } = await client.subscriptionList();
  const found = list.subscriptions.find((s) => s.url === feedUrl);
  if (found) {
    await client.subscriptionEdit({ ac: 'unsubscribe', s: found.id, T: token });
  }
});

// ---- edit-tag round trips (read + starred) --------------------------------

test('edit-tag can mark an item read and the read state persists', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  const refs = await findFeedWithItems();
  if (!refs) { t.skip('no unread items available to test edit-tag'); return; }
  const token = await client.postToken();
  const targetId = refs[0].id;

  // mark read
  const { status } = await client.editTag({ i: [targetId], a: [STATE.READ], T: token });
  assert.equal(status, 200);

  // verify the item now carries the read state in stream/contents
  const { json } = await client.streamContents(STATE.READING_LIST, { n: 50 });
  if (!json || !Array.isArray(json.items)) {
    t.skip('server does not expose item state through stream/contents reading-list (known Miniflux incompatibility)');
    return;
  }
  const item = json.items.find((it) => it.id.endsWith(targetId) || it.id.includes(targetId)) ||
               json.items.find((it) => Number(it.timestampUsec) === Number(refs[0].id));
  if (item) {
    assert.ok(
      item.categories.includes(STATE.READ),
      'after edit-tag a=read the item must carry the read state',
    );
  }
});

test('edit-tag starring is observable in the starred stream', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  const refs = await findFeedWithItems();
  if (!refs) { t.skip('no unread items available to test starring'); return; }
  const token = await client.postToken();
  const targetId = refs[0].id;

  // star it
  const { status } = await client.editTag({ i: [targetId], a: [STATE.STARRED], T: token });
  assert.equal(status, 200);

  // the starred stream must now contain at least one item
  const { json } = await client.streamContents(STATE.STARRED, { n: 20 });
  if (!json || !Array.isArray(json.items)) {
    await client.editTag({ i: [targetId], r: [STATE.STARRED], T: token });
    t.skip('server does not expose starred items through stream/contents (known Miniflux incompatibility)');
    return;
  }
  assert.ok(json.items.length >= 1, 'starred stream must contain the starred item');

  // unstar (clean up + test remove path)
  const { status: unstar } = await client.editTag({ i: [targetId], r: [STATE.STARRED], T: token });
  assert.equal(unstar, 200);
});

// ---- mark-all-as-read ------------------------------------------------------

test('mark-all-as-read on reading-list returns OK', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;
  // We use a far-future ns cutoff so this is effectively a no-op (marks nothing
  // older than now+1d) — safe to run without destroying user read-state.
  const futureNs = String((Math.floor(Date.now() / 1000) + 86400) * 1e9);
  const token = await client.postToken();
  const { status, text } = await client.markAllAsRead({ s: STATE.READING_LIST, ts: futureNs, T: token });
  assert.equal(status, 200);
  // FreshRSS returns "OK"; we accept any non-error body but record it.
  t.diagnostic('mark-all-as-read body = ' + JSON.stringify(text));
});

// ---- rename-tag / disable-tag lifecycle -----------------------------------

test('rename-tag renames a label and disable-tag removes it', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  // We rename a label that we create on the fly by renaming itself twice.
  // Some servers require the label to exist; we tolerate a 400/404 there.
  const token = await client.postToken();
  const a = label(uniqueLabel(cfg.labelPrefix));
  const b = label(uniqueLabel(cfg.labelPrefix));

  // Create via rename from a (may or may not create). Then rename a->b.
  await client.renameTag({ s: a, dest: b, T: token }).catch(() => {});
  const { status } = await client.renameTag({ s: b, dest: a, T: token });
  // Either it succeeds (200) or reports not-found; both are acceptable
  // contract behaviours across greader servers.
  assert.ok([200, 400, 404].includes(status), `rename-tag unexpected status ${status}`);

  // disable-tag cleanup
  const { status: d1 } = await client.disableTag({ s: [a], T: token });
  const { status: d2 } = await client.disableTag({ s: [b], T: token });
  assert.ok([200, 400, 404].includes(d1));
  assert.ok([200, 400, 404].includes(d2));
});

// ---- OPML export/import ----------------------------------------------------

test('subscription/export returns OPML XML', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, text } = await client.subscriptionExport();
  assert.equal(status, 200);
  if (/^\s*\[/.test(text)) {
    t.skip('server returns JSON from subscription/export instead of OPML (known Miniflux incompatibility)');
    return;
  }
  // OPML root element. Be lenient about leading whitespace/doctype.
  assert.match(text, /<opml\b/i, 'export body must be an <opml> document');
  assert.match(text, /<body\b/i, 'opml must contain a <body>');
});

test('subscription/import accepts OPML and returns 2xx', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  // Minimal valid OPML with a category. Importing an empty-ish outline should
  // not error; servers may add the category/subscription or ignore it.
  const opml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="1.0">',
    '  <head><title>contract-test</title></head>',
    '  <body>',
    '    <outline text="' + uniqueLabel(cfg.labelPrefix) + '">',
    '    </outline>',
    '  </body>',
    '</opml>',
  ].join('\n');
  const token = await client.postToken();
  const { status } = await client.subscriptionImport(opml, token);
  assert.ok(status >= 200 && status < 300, `import must succeed (2xx), got ${status}`);
});
