'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GreaderClient, formEncode, parseLoginBody, STATE } = require('../lib/greader-client');
const { skipUnlessConfigured, configuredClient } = require('../lib/test-helpers');

test('unit: formEncode repeats array keys in order', () => {
  assert.equal(formEncode({ i: ['1', '2'], ac: 'subscribe' }), 'i=1&i=2&ac=subscribe');
  assert.equal(formEncode({ a: 'b c' }), 'a=b%20c');
  assert.equal(formEncode({ x: undefined, y: null, z: 0 }), 'z=0');
});

test('unit: parseLoginBody extracts SID/LSID/Auth', () => {
  const parsed = parseLoginBody('SID=alice/abc\nLSID=null\nAuth=alice/abc\n');
  assert.deepEqual(parsed, { SID: 'alice/abc', LSID: 'null', Auth: 'alice/abc' });
  assert.deepEqual(parseLoginBody(''), {});
});

test('unit: GreaderClient builds path-encoded stream URLs', () => {
  const c = new GreaderClient({ baseUrl: 'https://h/api/greader.php' });
  const u = c.url('/reader/api/0/stream/contents/' + STATE.READING_LIST.split('/').map(encodeURIComponent).join('/'));
  assert.equal(u, 'https://h/api/greader.php/reader/api/0/stream/contents/user/-/state/com.google/reading-list');
});

// ---- Live tests below require a server ------------------------------------

test('ClientLogin returns Auth token for valid credentials', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { client, cfg } = configuredClient();

  const parsed = await client.login();
  assert.ok(parsed.Auth, 'Auth= line must be present');
  assert.ok(parsed.Auth.includes('/'), 'Auth value must be "<user>/<token>"');
  // FreshRSS always returns LSID=null; some servers differ. We only require Auth.
  t.diagnostic('Auth user/token = ' + parsed.Auth);
});

test('ClientLogin accepts credentials in query string', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { client, cfg } = configuredClient();

  const { status, text } = await client._fetch('/accounts/ClientLogin', {
    method: 'POST',
    query: { Email: cfg.user, Passwd: cfg.password },
  });
  assert.equal(status, 200, 'query-string ClientLogin must return HTTP 200');
  const parsed = parseLoginBody(text);
  assert.ok(parsed.Auth, 'Auth= line must be present');
  assert.ok(parsed.Auth.includes('/'), 'Auth value must be "<user>/<token>"');
});

test('ClientLogin rejects bad credentials with 401', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const cfg = require('../lib/test-helpers').config();
  const bad = new GreaderClient({
    baseUrl: cfg.baseUrl,
    user: cfg.user,
    password: 'definitely-not-the-password-' + Date.now(),
  });
  await assert.rejects(
    () => bad.login(),
    /HTTP 401/,
    'wrong password must produce HTTP 401 (or at least non-200)',
  );
});

test('requests without Authorization header are rejected by the server', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const cfg = require('../lib/test-helpers').config();
  // Build a client and bypass the client-side login guard by going straight
  // to the low-level fetch (no Authorization header will be set).
  const noAuth = new GreaderClient({ baseUrl: cfg.baseUrl, user: cfg.user, password: cfg.password });
  const { status } = await noAuth._fetch('/reader/api/0/user-info', { method: 'GET' });
  assert.equal(status, 401, 'a request with no Authorization header must be rejected with HTTP 401');
});

test('token endpoint returns a non-empty plain-text token', { timeout: 60000 }, async (t) => {
  if (skipUnlessConfigured(t)) return;
  const { client } = configuredClient();
  await client.login();
  const token = await client.postToken();
  assert.ok(token.length > 0, 'token must be non-empty');
  // FreshRSS pads to 57 chars; other servers vary. Just require something usable.
  t.diagnostic('token length = ' + token.length);
});
