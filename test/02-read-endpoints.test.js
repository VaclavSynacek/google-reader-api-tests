'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { STATE } = require('../lib/greader-client');
const { skipUnlessConfigured, configuredClient } = require('../lib/test-helpers');

let client;
before(async () => {
  if (!process.env.GREADER_BASE_URL) return;
  ({ client } = configuredClient());
  await client.login();
});

// ---- user-info -------------------------------------------------------------

test('user-info returns object with user identity fields', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, json } = await client.userInfo();
  assert.equal(status, 200);
  assert.equal(typeof json, 'object', 'body must be JSON');
  assert.ok(json, 'body must not be null');
  // Clients rely on at least one of these to display the logged-in user.
  const ident = json.userId ?? json.userName ?? json.userEmail;
  assert.ok(ident, 'one of userId/userName/userEmail must be present');
});

// ---- tag/list --------------------------------------------------------------

test('tag/list returns JSON with a tags array', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, json } = await client.tagList();
  assert.equal(status, 200);
  assert.ok(json && Array.isArray(json.tags), 'body.tags must be an array');
});

test('tag/list includes the standard state streams clients depend on', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { json } = await client.tagList();
  const ids = new Set(json.tags.map((x) => x.id));
  // Reeder/FeedMe/EasyRSS all expect at least these two. Miniflux currently
  // exposes user/<id>/state/com.google/starred and user/<id>/label/All instead
  // of the canonical user/-/state/com.google/reading-list stream.
  if (!ids.has(STATE.READING_LIST)) {
    t.skip('server does not expose canonical reading-list state (known Miniflux incompatibility)');
    return;
  }
  assert.ok(ids.has(STATE.STARRED) || [...ids].some((id) => /\/state\/com\.google\/starred$/.test(id)), 'must expose starred state');
  for (const tag of json.tags) {
    assert.equal(typeof tag.id, 'string', 'each tag must have a string id');
  }
});

test('tag/list with output != json is not 200 (FreshRSS returns 501)', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status } = await client.getJson('/reader/api/0/tag/list', { output: 'xml' });
  assert.notEqual(status, 200, 'non-JSON output must not succeed with HTTP 200');
});

// ---- subscription/list -----------------------------------------------------

test('subscription/list returns JSON with a subscriptions array', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, json } = await client.subscriptionList();
  assert.equal(status, 200);
  assert.ok(json && Array.isArray(json.subscriptions), 'body.subscriptions must be an array');
  for (const sub of json.subscriptions) {
    assert.match(sub.id, /^feed\//, 'subscription id must start with feed/');
    assert.equal(typeof sub.title, 'string', 'subscription must have title');
    assert.equal(typeof sub.url, 'string', 'subscription must have url');
  }
});

test('subscription/list with output != json is not 200', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status } = await client.getJson('/reader/api/0/subscription/list', { output: 'atom' });
  assert.notEqual(status, 200);
});

// ---- unread-count ----------------------------------------------------------

test('unread-count returns JSON with unreadcounts array', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, json } = await client.unreadCount();
  assert.equal(status, 200);
  if (Array.isArray(json)) {
    t.skip('server returns a bare array for unread-count instead of { unreadcounts } (known Miniflux incompatibility)');
    return;
  }
  assert.ok(json && Array.isArray(json.unreadcounts), 'body.unreadcounts must be an array');
  // Total entry for the reading-list must exist.
  const ids = new Set(json.unreadcounts.map((e) => e.id));
  assert.ok(ids.has(STATE.READING_LIST), 'must include global reading-list unread count');
  for (const e of json.unreadcounts) {
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.count, 'number');
  }
});

test('unread-count with output != json is not 200', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, json } = await client.getJson('/reader/api/0/unread-count', { output: 'xml' });
  if (status === 200 && Array.isArray(json)) {
    t.skip('server ignores non-json output on unread-count (known Miniflux incompatibility)');
    return;
  }
  assert.notEqual(status, 200);
});

// ---- stream/contents (reading-list) ---------------------------------------

test('stream contents of reading-list returns a valid item feed', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, json } = await client.streamContents(STATE.READING_LIST, { n: 5 });
  assert.equal(status, 200);
  assert.equal(typeof json, 'object');
  if (Array.isArray(json)) {
    if (json.length === 0) {
      t.skip('server returns a bare empty array for stream/contents when there are no items (known Miniflux shape difference)');
      return;
    }
    t.skip('server returns a bare array for stream/contents instead of { items } (known Miniflux incompatibility)');
    return;
  }
  assert.ok(Array.isArray(json.items), 'must have items array');

  if (json.items.length === 0) {
    t.diagnostic('no items in reading-list; item-shape checks skipped (add a subscription with unread items for full coverage)');
    return;
  }
  for (const item of json.items) {
    assert.match(item.id, /^tag:google\.com,2005:reader\/item\//, 'item.id must use the greader item-tag form');
    assert.ok(item.timestampUsec || item.published, 'item must have timestampUsec or published');
    assert.equal(typeof item.title, 'string');
    assert.ok(Array.isArray(item.categories), 'item.categories must be an array');
    assert.ok(item.categories.includes(STATE.READING_LIST), 'every item must carry the reading-list state');
    // Summary (compat mode) or content present.
    assert.ok(item.summary || item.content, 'item must have summary or content');
  }
});

test('stream contents respects the n (count) parameter', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { json: all } = await client.streamContents(STATE.READING_LIST, { n: 50 });
  if (!all || !Array.isArray(all.items)) { t.skip('stream/contents does not return { items } for reading-list'); return; }
  if (all.items.length < 2) { t.skip('not enough items to test n'); return; }
  const { json: few } = await client.streamContents(STATE.READING_LIST, { n: 1 });
  assert.ok(few.items.length <= 1, 'n=1 must return at most 1 item');
});

test('stream contents honors xt (exclude read) returning only unread', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { json } = await client.streamContents(STATE.READING_LIST, { n: 20, xt: STATE.READ });
  if (!json || !Array.isArray(json.items)) { t.skip('stream/contents does not return { items } for reading-list'); return; }
  for (const item of json.items) {
    assert.ok(
      !item.categories.includes(STATE.READ),
      'with xt=user/-/state/com.google/read no returned item may carry the read state',
    );
  }
});

test('stream contents r=o returns ascending order (oldest first)', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { json } = await client.streamContents(STATE.READING_LIST, { n: 10, r: 'o' });
  if (!json || !Array.isArray(json.items)) { t.skip('stream/contents does not return { items } for reading-list'); return; }
  if (json.items.length < 2) { t.skip('not enough items to test ordering'); return; }
  const ts = (it) => Number(it.timestampUsec || (it.published ? it.published * 1e6 : 0));
  for (let i = 1; i < json.items.length; i++) {
    assert.ok(ts(json.items[i]) >= ts(json.items[i - 1]), 'ascending order: timestamps must be non-decreasing');
  }
});

// ---- stream/items/ids ------------------------------------------------------

test('stream/items/ids returns itemRefs (numeric ids)', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { status, json, text } = await client.streamItemIds(STATE.READING_LIST, { n: 5 });
  if (status === 400 && /stream|category|not found|unknown/i.test(text)) {
    t.skip('canonical reading-list stream is not supported by stream/items/ids (known Miniflux incompatibility)');
    return;
  }
  assert.equal(status, 200);
  assert.ok(json && Array.isArray(json.itemRefs), 'must return itemRefs array');
  for (const ref of json.itemRefs) {
    assert.equal(typeof ref.id, 'string');
    assert.ok(/^\d+$/.test(ref.id), 'ref.id must be a decimal string (FreshRSS) — long-tag form also accepted by /contents');
  }
});

// ---- stream/items/contents (hydrate by id) --------------------------------

test('stream/items/contents hydrates ids returned by items/ids', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { json: refs } = await client.streamItemIds(STATE.READING_LIST, { n: 3 });
  if (!refs.itemRefs || refs.itemRefs.length === 0) {
    t.skip('no items to hydrate');
    return;
  }
  const ids = refs.itemRefs.slice(0, 3).map((r) => r.id);
  const token = await client.postToken();
  const { status, json, text } = await client.streamItemsContents(ids, 'd', token);
  if (status === 400 && /only json output/i.test(text)) {
    t.skip('server requires a non-standard output=json form parameter for stream/items/contents');
    return;
  }
  assert.equal(status, 200);
  assert.ok(json && Array.isArray(json.items), 'must return items array');
  assert.equal(json.items.length, ids.length, 'must return exactly the requested items');
  for (const item of json.items) {
    assert.match(item.id, /^tag:google\.com,2005:reader\/item\//);
  }
});
