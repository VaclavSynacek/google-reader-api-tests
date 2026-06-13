# Google Reader API Contract Tests

A dependency-free Node.js test suite for the Google Reader-compatible API.
The goal: if these tests pass against a server, that server can reasonably be
expected to work with established greader client apps (Reeder, FeedMe, EasyRSS,
News+, Newsboat, Read You, Vienna, …).

The protocol contract being tested is documented in
[`google-reader-api.openapi.yaml`](./google-reader-api.openapi.yaml), derived
from FreshRSS source (`p/api/greader.php` and `Entry::toGReader()`). FreshRSS
is the reference implementation; the API is wire-compatible across the
Inoreader / The Old Reader / BazQux / FeedHQ ecosystem.

## Requirements

- Node.js >= 18 (uses global `fetch` and the built-in `node:test` runner).
- No `npm install` — there are no dependencies.

## Quick start

```sh
npm test
```

With no server configured this runs the unit tests and skips the live tests,
so it is always safe to invoke.

To run against a real server:

```sh
export GREADER_BASE_URL=https://localhost/api/greader.php
export GREADER_USER=alice
export GREADER_PASSWORD=<api password>   # FreshRSS API password, not the account password
npm test
```

## Test groups

There are three independent groups, in separate files:

| File | Group | What it verifies |
|------|-------|------------------|
| `test/01-auth.test.js` | Authentication | `ClientLogin` flow, POST token, auth rejection. Includes unit tests. |
| `test/02-read-endpoints.test.js` | GET operations | Every read endpoint + JSON-shape checks, `output=json` enforcement, ordering, pagination. |
| `test/03-write-endpoints.test.js` | Update operations | Every mutating endpoint + round-trip flows (subscribe/unsubscribe, edit-tag read/star cycles, rename/disable-tag, OPML import/export, mark-all-as-read). |
| `test/04-feed-ingestion.test.js` | Feed ingestion | **Server behavior, not protocol contract.** Verifies the server actually fetches RSS sources and reflects new/changed items. |

The first three are protocol contract tests: a server that fails any of them
will break real greader clients. The fourth is a server-behavior test: the
greader API has no refresh endpoint, so it exercises the server's
out-of-band feed fetching.

### Feed ingestion tests

These start a bundled in-process RSS 2.0 feed server (`lib/feed-server.js`),
subscribe the greader server to it, force a refresh, and poll `stream/contents`
to assert that:

- new items added to the feed appear after a refresh, and
- an item updated in place (same `<guid>`) is reflected with its new title.

Since the greader API has no refresh primitive, the suite forces a refresh
through `lib/refresh.js`, which tries two strategies in order:

1. **`GREADER_REFRESH_CMD`** — an arbitrary shell command. The universal
   escape hatch for servers with a proprietary refresh mechanism
   (e.g. `docker exec freshrss php app/actualize_script.php`, an SSH to an
   admin host, a vendor admin API curl). Run via `/bin/sh -c`.
2. **OPML-import fallback** — posts a minimal valid but empty OPML document
   to `/reader/api/0/subscription/import`. FreshRSS runs
   `actualizeFeedsAndCommit()` as a side effect of a successful import, so an
   empty-but-valid OPML triggers a refresh of all feeds without changing
   subscriptions. Any server that refreshes-after-import behaves the same.

The bundled feed server listens on `127.0.0.1` by default. For a server on
the same host (the common case) this just works. If the greader server runs
on a different host, set `GREADER_FEED_PUBLIC_URL` to an address that host
can resolve.

## Configuration

All configuration is via environment variables.

### Connection (required for live tests)

| Variable | Default | Description |
|----------|---------|-------------|
| `GREADER_BASE_URL` | — | Server base, e.g. `https://localhost/api/greader.php`. |
| `GREADER_USER` | — | Username (`Email`). |
| `GREADER_PASSWORD` | — | API password. |
| `GREADER_TIMEOUT_MS` | `20000` | Per-request HTTP timeout. |

The write/ingestion tests subscribe the server to the **bundled in-process
RSS feed server** (no external feed needed). They only need the server under
test to be able to reach that feed; see the feed-connection vars below.

### Test selection

| Variable | Default | Effect when `=1` |
|----------|---------|------------------|
| `GREADER_SKIP_WRITES` | unset | Skip the update-operation tests (group 3) that mutate server state. |
| `GREADER_SKIP_INGESTION` | unset | Skip only the feed-ingestion tests (group 4). |

Without any skip flag, all four groups run.

### Feed ingestion

| Variable | Default | Description |
|----------|---------|-------------|
| `GREADER_REFRESH_CMD` | unset | Shell command to force a server refresh. If unset, the OPML-import fallback is used. |
| `GREADER_FEED_BIND` | `0.0.0.0:0` | Bind spec for the bundled feed server (`0` = ephemeral port; each test file gets its own). |
| `GREADER_FEED_PUBLIC_HOST` | derived from bind | Host the greader server uses to reach the bundled feed (e.g. `172.17.0.1` when the server runs in Docker and the feed on the host). The port is appended at runtime. |
| `GREADER_FEED_PUBLIC_URL` | unset | Full URL override; if set it wins verbatim (advanced). |
| `GREADER_INGESTION_TIMEOUT_MS` | `120000` | How long to poll for items to appear after a refresh. |
| `GREADER_INGESTION_POLL_MS` | `3000` | Poll interval. |
| `GREADER_INGESTION_REFRESH_DELAY_MS` | `1000` | Delay before the second refresh in the ingestion tests; helps servers with slow/proprietary refresh mutexes. |

## Examples

Run only the read-only contract tests:

```sh
GREADER_SKIP_WRITES=1 npm test
```

Run everything including ingestion against a local FreshRSS (which refreshes
on OPML import, so no `GREADER_REFRESH_CMD` is needed):

```sh
export GREADER_BASE_URL=https://localhost/api/greader.php
export GREADER_USER=alice
export GREADER_PASSWORD=secret
npm test
```

Run ingestion against a server with a proprietary refresh, skipping the
update-operation contract tests but keeping ingestion:

```sh
export GREADER_BASE_URL=https://localhost/api/greader.php
export GREADER_USER=alice
export GREADER_PASSWORD=secret
export GREADER_REFRESH_CMD='docker exec freshrss php app/actualize_script.php'
export GREADER_SKIP_WRITES=1          # skip group 3 (ingestion has its own toggle)
npm test
```

## Reference-server harnesses

`docker/` contains harnesses that bring up a reference greader server in a
container and run the whole suite against it. Each implementation gets its
own subdirectory so the harnesses can serve as templates for new servers:

```
docker/freshrss/             FreshRSS reference harness (template for new ones)
  docker-compose.yml         brings up the server container
  provision-freshrss.sh      creates user + API password, fixes permissions
  env.sh                     exports GREADER_* to point at the container
  freshrss-data/             server runtime state (gitignored)
```

Run the FreshRSS reference suite end-to-end:

```sh
docker compose -f docker/freshrss/docker-compose.yml up -d
docker/freshrss/provision-freshrss.sh
source docker/freshrss/env.sh   # exports GREADER_* to point at the container
npm test
```

To add a harness for another server (Tiny Tiny RSS + greader plugin, Miniflux
greader adapter, …), copy the `docker/freshrss/` layout: a `docker-compose.yml`
that brings up the server, a `provision-<server>.sh` that creates the user and
API password and fixes container permissions, and an `env.sh` that exports the
`GREADER_*` vars (notably `GREADER_FEED_PUBLIC_HOST` so the container can
reach the host's bundled feed server, and `GREADER_REFRESH_CMD` if the server
has a proprietary refresh).

## Layout

```
google-reader-api.openapi.yaml   the protocol contract (authoritative)
lib/greader-client.js            wire client: GoogleLogin auth, form encoding, endpoints
lib/test-helpers.js              env config + skip helpers
lib/refresh.js                   refresh strategy: GREADER_REFRESH_CMD or OPML-import fallback
lib/feed-server.js               bundled in-process RSS 2.0 feed server
test/01-auth.test.js             authentication
test/02-read-endpoints.test.js   GET operations
test/03-write-endpoints.test.js  update operations
test/04-feed-ingestion.test.js   feed ingestion (server behavior)
docker/freshrss/                FreshRSS reference harness (template for more servers)
```
