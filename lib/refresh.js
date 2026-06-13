'use strict';

const { exec } = require('node:child_process');

/**
 * Force the greader server to refresh (re-fetch) its RSS sources.
 *
 * The Google Reader API has no refresh endpoint, so this is necessarily an
 * out-of-band operation. Two strategies, tried in order:
 *
 *   1. GREADER_REFRESH_CMD — an arbitrary shell command. This is the universal
 *      escape hatch for servers with a proprietary refresh mechanism
 *      (docker exec ... freshrss-actualize, ssh admin@host ..., curl a vendor
 *      admin API, etc.). Run as-is via /bin/sh -c.
 *
 *   2. OPML-import trick (fallback) — POST a minimal *valid but empty* OPML to
 *      /reader/api/0/subscription/import. FreshRSS calls
 *      actualizeFeedsAndCommit() as a side effect of a successful import, and
 *      an empty-but-valid OPML parses successfully while adding zero feeds,
 *      so the refresh fires and subscriptions are untouched. Any other server
 *      that refreshes-after-import will behave the same. Servers that do NOT
 *      refresh on import will simply return 2xx with no effect — the caller
 *      can detect that (items never appear) and report it.
 *
 * Note: an empty body is NOT valid OPML and will be rejected (400). We send a
 * proper <opml> document with an empty <body>.
 *
 * @param {import('./greader-client').GreaderClient} client  authenticated client
 * @param {object} cfg  config() object
 * @returns {Promise<{method: 'cmd'|'opml'|'none', ok: boolean, detail: string}>}
 */
async function refreshFeeds(client, cfg) {
  // --- Strategy 1: external command ---------------------------------------
  if (cfg.refreshCmd && cfg.refreshCmd.trim()) {
    const detail = await runCommand(cfg.refreshCmd, cfg.timeoutMs);
    return { method: 'cmd', ok: detail.exitCode === 0, detail: detail.text };
  }

  // --- Strategy 2: OPML-import trick --------------------------------------
  // Minimal valid OPML with no outlines. LibOpML parses it; FreshRSS then
  // runs actualizeFeedsAndCommit() because importOpml() leaves lastStatus=true.
  const emptyOpml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>refresh-trigger</title></head>',
    '  <body></body>',
    '</opml>',
  ].join('\n');

  try {
    const token = await client.postToken().catch(() => '');
    const res = await client.subscriptionImport(emptyOpml, token);
    const ok = res.status >= 200 && res.status < 300;
    return {
      method: 'opml',
      ok,
      detail: `import HTTP ${res.status}: ${res.text.slice(0, 120)}`,
    };
  } catch (e) {
    return { method: 'opml', ok: false, detail: 'import threw: ' + e.message };
  }
}

/** Run a shell command and capture stdout+stderr. Resolves (never rejects). */
function runCommand(cmd, timeoutMs) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, shell: '/bin/sh' }, (err, stdout, stderr) => {
      const exitCode = err ? (err.code ?? 1) : 0;
      const text = (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).trim();
      if (err && err.killed) {
        resolve({ exitCode: 124, text: text + '\n[command timed out]' });
      } else {
        resolve({ exitCode, text });
      }
    });
  });
}

module.exports = { refreshFeeds, runCommand };
