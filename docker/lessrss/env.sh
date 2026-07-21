#!/usr/bin/env bash
# Source this to point the suite at the bundled lessRss instance.
export GREADER_BASE_URL='http://localhost:8082/api/greader.php'
export GREADER_USER='alice'
export GREADER_PASSWORD='aliceapi'

# lessRss refreshes feeds synchronously on OPML import, so leave
# GREADER_REFRESH_CMD unset and use the suite's built-in fallback.
unset GREADER_REFRESH_CMD

export GREADER_FEED_BIND='0.0.0.0:0'
export GREADER_FEED_PUBLIC_HOST='172.17.0.1'
unset GREADER_FEED_URL
