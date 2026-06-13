#!/usr/bin/env bash
# Source this to point the test suite at the bundled Miniflux:
#   source docker/miniflux/env.sh
#
# Miniflux exposes the Google Reader API as a built-in integration. The API
# credentials are configured through the Miniflux UI or via its own REST API.
# The harness provisioning script sets them to the defaults below.

export GREADER_BASE_URL='http://localhost:8081'
export GREADER_USER='alice'
export GREADER_PASSWORD='alicegr'   # Google Reader API credentials in Miniflux

# Force refreshes for the ingestion tests through Miniflux's own CLI. The
# greader API has no refresh endpoint, and Miniflux does not refresh as a side
# effect of OPML import like FreshRSS does.
export GREADER_REFRESH_CMD='docker exec miniflux-greader-tests /usr/bin/miniflux -reset-feed-next-check-at && docker exec miniflux-greader-tests /usr/bin/miniflux -refresh-feeds'

# The bundled feed server is still used by the ingestion tests; Miniflux runs
# on the host network via localhost and can reach the host's Docker bridge.
export GREADER_FEED_BIND='0.0.0.0:0'
export GREADER_FEED_PUBLIC_HOST='172.17.0.1'
