#!/usr/bin/env bash
# Source this to point the test suite at the bundled FreshRSS:
#   source docker/freshrss/env.sh
#
# Assumes FreshRSS is reachable at http://localhost:8080 (see docker-compose.yml)
# and that the bundled feed server (started by the ingestion tests) listens on
# the host. FreshRSS reaches the host through the Docker bridge gateway.

# greader API base + credentials. Must match what provision-freshrss.sh created.
export GREADER_BASE_URL='http://localhost:8080/api/greader.php'
export GREADER_USER='alice'
export GREADER_PASSWORD='aliceapi'   # FreshRSS API password (not account pw)

# FreshRSS's bundled feed fetcher (SimplePie) lives inside the container; it
# reaches the host's feed server via the default Docker bridge gateway. We bind
# to an ephemeral port (each test file gets its own) and tell the server where
# to find us by host only — the port is appended at runtime.
export GREADER_FEED_BIND='0.0.0.0:0'
export GREADER_FEED_PUBLIC_HOST='172.17.0.1'

# FreshRSS refreshes feeds as a side effect of an OPML import, so the suite's
# built-in OPML-import fallback works. But an explicit refresh is faster and
# more deterministic — use the container's actualize script.
export GREADER_REFRESH_CMD='docker exec freshrss-greader-tests sh -c "/var/www/FreshRSS/app/actualize_script.php > /tmp/actualize.log 2>&1 || php /var/www/FreshRSS/app/actualize_script.php"'
export GREADER_INGESTION_REFRESH_DELAY_MS='1000'

# GREADER_FEED_URL is no longer used by the write tests (they subscribe to the
# bundled in-process feed server). Kept only for backward compatibility.
unset GREADER_FEED_URL
