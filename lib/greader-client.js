'use strict';

/**
 * Minimal HTTP client for the Google Reader-compatible API.
 *
 * Implements the exact wire details that real greader clients (Reeder,
 * FeedMe, EasyRSS, News+, Newsboat, Read You, ...) depend on:
 *
 *   - Two-step auth: POST /accounts/ClientLogin -> "Auth=<user>/<token>"
 *   - Subsequent requests send header:
 *         Authorization: GoogleLogin auth=<user>/<token>
 *   - POST bodies are application/x-www-form-urlencoded, with repeatable
 *     fields (e.g. multiple `i`, `a`, `r`).
 *   - GET params use the standard greader names (output, n, r, ot, nt,
 *     xt, it, c, ck, s, client).
 *   - Read endpoints return JSON; mutations return the plain text "OK";
 *     ClientLogin/token return plain text.
 *
 * No external dependencies on purpose — Node built-in fetch only.
 */

const STATE = {
  READ: 'user/-/state/com.google/read',
  UNREAD: 'user/-/state/com.google/unread',
  STARRED: 'user/-/state/com.google/starred',
  READING_LIST: 'user/-/state/com.google/reading-list',
  BROADCAST: 'user/-/state/com.google/broadcast',
  LIKE: 'user/-/state/com.google/like',
  KEPT_UNREAD: 'user/-/state/com.google/tracking-kept-unread',
  // FreshRSS extensions (org.freshrss.*). Still greader-compatible.
  FRSS_MAIN: 'user/-/state/org.freshrss/main',
  FRSS_IMPORTANT: 'user/-/state/org.freshrss/important',
};

const PREFIX = {
  FEED: 'feed/',
  LABEL: 'user/-/label/',
  ITEM: 'tag:google.com,2005:reader/item/',
};

/** Build a label/category stream id. */
function label(name) {
  return PREFIX.LABEL + name;
}

/** Build a feed stream id. */
function feed(id) {
  return PREFIX.FEED + String(id);
}

/**
 * Encode a form body that supports repeatable keys.
 *   formEncode({ i: ['a','b'], ac: 'subscribe' })  =>  "i=a&i=b&ac=subscribe"
 */
function formEncode(obj) {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.join('&');
}

/**
 * Parse the plain-text ClientLogin response body.
 *   "SID=x\nLSID=null\nAuth=y\n"  =>  { SID: 'x', LSID: 'null', Auth: 'y' }
 */
function parseLoginBody(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

class GreaderClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl  e.g. https://freshrss.example.net/api/greader.php
   * @param {string} [opts.user]
   * @param {string} [opts.password]
   * @param {number} [opts.timeoutMs=20000]
   * @param {string} [opts.userAgent]  override User-Agent header
   */
  constructor(opts) {
    if (!opts || !opts.baseUrl) {
      throw new Error('GreaderClient: baseUrl is required');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.user = opts.user;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.userAgent = opts.userAgent ?? 'greader-contract-tests/1.0';
    /** @type {string|null} "<user>/<token>" */
    this._auth = null;
  }

  /** Full URL for a path (path may start with "/"). */
  url(path, query) {
    let u = this.baseUrl + (path.startsWith('/') ? path : '/' + path);
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) qs.append(k, String(item));
        } else {
          qs.append(k, String(v));
        }
      }
      u += '?' + qs.toString();
    }
    return u;
  }

  async _fetch(path, { method = 'GET', query, body, headers = {}, raw = false } = {}) {
    const url = this.url(path, query);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const reqHeaders = { 'User-Agent': this.userAgent, ...headers };
    let reqBody;
    if (body !== undefined) {
      if (typeof body === 'string') {
        reqBody = body;
        // Caller is responsible for setting Content-Type if needed.
      } else {
        reqBody = formEncode(body);
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }
    if (this._auth) {
      reqHeaders['Authorization'] = 'GoogleLogin auth=' + this._auth;
    }
    let res;
    try {
      res = await fetch(url, { method, headers: reqHeaders, body: reqBody, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (raw) {
      return { status: res.status, headers: res.headers, text };
    }
    return { status: res.status, headers: res.headers, text };
  }

  /** Authenticate and store the auth token. Returns { SID, LSID, Auth }. */
  async login() {
    const { status, text } = await this._fetch('/accounts/ClientLogin', {
      method: 'POST',
      body: { Email: this.user, Passwd: this.password },
    });
    if (status !== 200) {
      throw new Error(`ClientLogin failed: HTTP ${status}`);
    }
    const parsed = parseLoginBody(text);
    if (!parsed.Auth) {
      throw new Error('ClientLogin response missing Auth= line. Body was:\n' + text);
    }
    this._auth = parsed.Auth;
    return parsed;
  }

  /** Require authentication; throws if login() was not called. */
  _requireAuth() {
    if (!this._auth) {
      throw new Error('Not authenticated: call client.login() first');
    }
  }

  // ---- raw verb helpers (auth-aware) ------------------------------------

  /** GET that returns parsed JSON (with status). */
  async getJson(path, query) {
    this._requireAuth();
    const { status, text } = await this._fetch(path, { method: 'GET', query });
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    return { status, text, json };
  }

  /** GET that returns plain text (with status). */
  async getText(path, query) {
    this._requireAuth();
    return this._fetch(path, { method: 'GET', query });
  }

  /** POST form; returns { status, text, json? }. */
  async post(path, body, { parseJson = false } = {}) {
    this._requireAuth();
    const { status, text } = await this._fetch(path, { method: 'POST', body });
    let json = null;
    if (parseJson) {
      try { json = text ? JSON.parse(text) : null; } catch { /* null */ }
    }
    return { status, text, json };
  }

  // ---- high-level endpoint wrappers -------------------------------------

  /** GET /reader/api/0/token -> plain text POST token. */
  async postToken() {
    const { status, text } = await this.getText('/reader/api/0/token');
    if (status !== 200) throw new Error(`token failed: HTTP ${status}`);
    return text.trim();
  }

  userInfo() { return this.getJson('/reader/api/0/user-info'); }
  tagList() { return this.getJson('/reader/api/0/tag/list', { output: 'json' }); }
  subscriptionList() { return this.getJson('/reader/api/0/subscription/list', { output: 'json' }); }
  unreadCount() { return this.getJson('/reader/api/0/unread-count', { output: 'json' }); }

  subscriptionEdit(fields) { return this.post('/reader/api/0/subscription/edit', fields); }
  quickAdd(url) { return this.post('/reader/api/0/subscription/quickadd', { quickadd: url }, { parseJson: true }); }
  subscriptionExport() { return this.getText('/reader/api/0/subscription/export'); }
  subscriptionImport(opml) {
    return this._fetch('/reader/api/0/subscription/import', {
      method: 'POST',
      body: opml,
      headers: { 'Content-Type': 'text/xml' },
    });
  }

  streamContents(streamId, query) {
    // Stream id is appended as a path (FreshRSS / BazQux form).
    const path = '/reader/api/0/stream/contents/' + streamId.split('/').map(encodeURIComponent).join('/');
    return this.getJson(path, query);
  }

  streamItemIds(streamId, query) {
    return this.getJson('/reader/api/0/stream/items/ids', { s: streamId, ...query });
  }

  streamItemsContents(ids, order) {
    return this.post('/reader/api/0/stream/items/contents', { i: ids, r: order }, { parseJson: true });
  }

  editTag({ i, a, r, T }) {
    return this.post('/reader/api/0/edit-tag', { i, a, r, T });
  }
  renameTag({ s, dest, T }) { return this.post('/reader/api/0/rename-tag', { s, dest, T }); }
  disableTag({ s, T }) { return this.post('/reader/api/0/disable-tag', { s, T }); }
  markAllAsRead({ s, ts, T }) { return this.post('/reader/api/0/mark-all-as-read', { s, ts, T }); }
}

module.exports = { GreaderClient, STATE, PREFIX, label, feed, formEncode, parseLoginBody };
