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
async function unsubscribeFeedIfPresent(url = feedUrl) {
  const { json } = await client.subscriptionList();
  const existing = json.subscriptions.find((s) => s.url === url);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

test('subscription edit persists a custom feed title', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  await unsubscribeFeedIfPresent();
  const token = await client.postToken();
  const { status: subscribeStatus } = await client.subscriptionEdit({
    ac: 'subscribe', s: feed(feedUrl), T: token,
  });
  assert.equal(subscribeStatus, 200);

  const { json: subscribed } = await client.subscriptionList();
  const found = subscribed.subscriptions.find((s) => s.url === feedUrl);
  assert.ok(found, 'newly subscribed feed must appear in subscription/list');
  t.after(async () => {
    try { await unsubscribeFeedIfPresent(); } catch { /* ignore */ }
  });

  const customTitle = 'Edited title ' + uniqueLabel('');
  const { status: editStatus } = await client.subscriptionEdit({
    ac: 'edit', s: found.id, t: customTitle, T: token,
  });
  assert.equal(editStatus, 200, 'subscription edit must return HTTP 200');

  const { json: edited } = await client.subscriptionList();
  const after = edited.subscriptions.find((s) => s.id === found.id || s.url === feedUrl);
  assert.ok(after, 'edited subscription must remain in subscription/list');
  assert.equal(after.title, customTitle, 'subscription edit t must persist the custom title');
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

test('quickadd discovers feeds from HTML and prefers a well-named main feed', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  const pageUrl = new URL('discovery-good-name.html', feedUrl).href;
  const commentsUrl = new URL('comments.xml', feedUrl).href;
  const blogUrl = new URL('blog.xml', feedUrl).href;
  await unsubscribeFeedIfPresent(commentsUrl);
  await unsubscribeFeedIfPresent(blogUrl);
  t.after(async () => {
    try { await unsubscribeFeedIfPresent(commentsUrl); } catch { /* ignore */ }
    try { await unsubscribeFeedIfPresent(blogUrl); } catch { /* ignore */ }
  });

  const token = await client.postToken();
  const { status, json } = await client.quickAdd(pageUrl, token);
  assert.equal(status, 200);
  assert.equal(json?.numResults, 1, json?.error || 'HTML feed discovery failed');

  const { json: list } = await client.subscriptionList();
  assert.ok(list.subscriptions.some((s) => s.url === blogUrl), 'the well-named Blog feed must be selected');
  assert.ok(!list.subscriptions.some((s) => s.url === commentsUrl), 'the earlier Comments Feed must not be selected');
});

test('quickadd uses HTML document order when no discovered feed has a preferred name', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  const pageUrl = new URL('discovery-document-order.html', feedUrl).href;
  const firstUrl = new URL('first.xml', feedUrl).href;
  const secondUrl = new URL('second.xml', feedUrl).href;
  await unsubscribeFeedIfPresent(firstUrl);
  await unsubscribeFeedIfPresent(secondUrl);
  t.after(async () => {
    try { await unsubscribeFeedIfPresent(firstUrl); } catch { /* ignore */ }
    try { await unsubscribeFeedIfPresent(secondUrl); } catch { /* ignore */ }
  });

  const token = await client.postToken();
  const { status, json } = await client.quickAdd(pageUrl, token);
  assert.equal(status, 200);
  assert.equal(json?.numResults, 1, json?.error || 'HTML feed discovery failed');

  const { json: list } = await client.subscriptionList();
  assert.ok(list.subscriptions.some((s) => s.url === firstUrl), 'the first feed in document order must be selected');
  assert.ok(!list.subscriptions.some((s) => s.url === secondUrl), 'only one discovered feed should be subscribed');
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
  // A zero cutoff is a genuine no-op: no normally timestamped item is older
  // than or equal to the Unix epoch. A future cutoff would mark everything.
  const token = await client.postToken();
  const { status, text } = await client.markAllAsRead({ s: STATE.READING_LIST, ts: '0', T: token });
  assert.equal(status, 200);
  // FreshRSS returns "OK"; we accept any non-error body but record it.
  t.diagnostic('mark-all-as-read body = ' + JSON.stringify(text));
});

// ---- subscription categories + rename-tag / disable-tag lifecycle --------

test('subscription categories can be added, removed, renamed and disabled', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  await unsubscribeFeedIfPresent();
  const token = await client.postToken();
  const source = label(uniqueLabel(cfg.labelPrefix));
  const destination = label(uniqueLabel(cfg.labelPrefix));
  assert.equal((await client.subscriptionEdit({
    ac: 'subscribe', s: feed(feedUrl), a: source, T: token,
  })).status, 200);
  t.after(async () => {
    try { await unsubscribeFeedIfPresent(); } catch { /* ignore */ }
    try { await client.disableTag({ s: [source, destination], T: await client.postToken() }); } catch { /* ignore */ }
  });

  let found = (await client.subscriptionList()).json.subscriptions.find((sub) => sub.url === feedUrl);
  assert.ok(found, 'categorized subscription must appear in subscription/list');
  assert.ok((found.categories || []).some((category) => category.id === source), 'subscribe a= must add the category');
  assert.ok((await client.tagList()).json.tags.some((tag) => tag.id === source), 'added category must appear in tag/list');

  assert.equal((await client.renameTag({ s: source, dest: destination, T: token })).status, 200);
  found = (await client.subscriptionList()).json.subscriptions.find((sub) => sub.url === feedUrl);
  assert.ok((found.categories || []).some((category) => category.id === destination), 'renamed category must be attached to the subscription');
  assert.ok(!(found.categories || []).some((category) => category.id === source), 'old category must be removed after rename');
  const renamedTags = (await client.tagList()).json.tags.map((tag) => tag.id);
  assert.ok(renamedTags.includes(destination), 'renamed category must appear in tag/list');
  assert.ok(!renamedTags.includes(source), 'old category must disappear from tag/list');

  assert.equal((await client.subscriptionEdit({ ac: 'edit', s: found.id, r: destination, T: token })).status, 200);
  found = (await client.subscriptionList()).json.subscriptions.find((sub) => sub.url === feedUrl);
  assert.ok(!(found.categories || []).some((category) => category.id === destination), 'subscription edit r= must remove the category');

  assert.equal((await client.subscriptionEdit({ ac: 'edit', s: found.id, a: destination, T: token })).status, 200);
  assert.equal((await client.disableTag({ s: [destination], T: token })).status, 200);
  found = (await client.subscriptionList()).json.subscriptions.find((sub) => sub.url === feedUrl);
  assert.ok(!(found.categories || []).some((category) => category.id === destination), 'disabled category must be detached from subscriptions');
  assert.ok(!(await client.tagList()).json.tags.some((tag) => tag.id === destination), 'disabled category must disappear from tag/list');
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

test('subscription import preserves an explicit OPML title', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  if (skipIfWritesDisabled(t)) return;

  await unsubscribeFeedIfPresent();
  const importedTitle = 'Imported title ' + uniqueLabel('');
  const importedLabelName = uniqueLabel(cfg.labelPrefix + 'Imported');
  const importedLabel = label(importedLabelName);
  const opml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>contract-test</title></head>',
    '  <body>',
    `    <outline text="${importedLabelName}" title="${importedLabelName}">`,
    `      <outline type="rss" text="${importedTitle}" title="${importedTitle}" xmlUrl="${feedUrl}" htmlUrl="https://example.test/imported/"/>`,
    '    </outline>',
    '  </body>',
    '</opml>',
  ].join('\n');
  const token = await client.postToken();
  const { status } = await client.subscriptionImport(opml, token);
  assert.ok(status >= 200 && status < 300, `import must succeed (2xx), got ${status}`);
  t.after(async () => {
    try { await unsubscribeFeedIfPresent(); } catch { /* ignore */ }
    try { await client.disableTag({ s: [importedLabel], T: await client.postToken() }); } catch { /* ignore */ }
  });

  const { json } = await client.subscriptionList();
  const found = json.subscriptions.find((s) => s.url === feedUrl);
  assert.ok(found, 'OPML feed outline must create a subscription');
  assert.equal(found.title, importedTitle, 'OPML title/text must be preserved as the subscription title');
  assert.ok((found.categories || []).some((category) => category.id === importedLabel), 'OPML parent outline must be imported as a category');

  const exported = await client.subscriptionExport();
  assert.match(exported.text, new RegExp(`<(?:outline)[^>]+(?:text|title)="${escapeRegExp(importedLabelName)}"`), 'export must retain the category outline');
  assert.match(exported.text, new RegExp(`xmlUrl="${escapeRegExp(feedUrl)}"`), 'export must retain the categorized subscription');
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
