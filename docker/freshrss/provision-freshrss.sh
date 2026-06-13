#!/usr/bin/env bash
# Provision a single-user FreshRSS instance inside the docker-compose service.
#
# Idempotent: safe to re-run. Installs FreshRSS (SQLite, no external DB) and
# creates:
#   user        alice
#   password    alicepass
#   API passw.  aliceapi   (what greader clients authenticate with)
#
# Run AFTER `docker compose -f docker/freshrss/docker-compose.yml up -d` and
# once the web container is up.
#
# This script is a template: copy it (and the sibling docker-compose.yml /
# env.sh) to provision other greader-compatible servers.
set -euo pipefail

CONTAINER="${FRESHRSS_CONTAINER:-freshrss-greader-tests}"
USER="${FRESHRSS_USER:-alice}"
PASS="${FRESHRSS_PASS:-alicepass}"
API="${FRESHRSS_API:-aliceapi}"
DB_TYPE="${FRESHRSS_DB_TYPE:-sqlite}"
BASE_URL="${FRESHRSS_BASE_URL:-http://localhost:8080}"

echo "==> Waiting for FreshRSS container to be up..."
# _cli.php is not marked executable in the image; test for its presence.
until docker exec "$CONTAINER" test -f /var/www/FreshRSS/cli/_cli.php >/dev/null 2>&1; do
  sleep 1
done

echo "==> Installing FreshRSS (idempotent)..."
# do-install.php is a no-op if already installed, but exits non-zero in that
# case ("already installed"). Tolerate that — it's idempotent by design.
docker exec "$CONTAINER" \
  /var/www/FreshRSS/cli/do-install.php \
    --default-user="$USER" \
    --db-type="$DB_TYPE" \
    --base-url="$BASE_URL" \
    --auth-type=form \
    --api-enabled \
    --language=en 2>&1 | sed 's/^/    /' || true

echo "==> Creating user '$USER' (idempotent)..."
# create-user.php errors out if the user exists; on that path, reapply the
# password and API password via update-user.php.
if docker exec "$CONTAINER" \
    /var/www/FreshRSS/cli/create-user.php \
    --user "$USER" --password "$PASS" --api-password "$API" 2>&1 | sed 's/^/    /'; then
  echo "    user created"
else
  echo "    user already exists; reapplying password + API password"
  docker exec "$CONTAINER" \
    /var/www/FreshRSS/cli/update-user.php \
    --user "$USER" --password "$PASS" --api-password "$API" 2>&1 | sed 's/^/    /'
fi

echo "==> Fixing access permissions..."
# The CLI runs as root inside the container, but Apache serves as www-data.
# Without this, www-data cannot read data/users/<user>/config.php and the
# greader API returns 401 with "configuration cannot be found" in the logs.
docker exec "$CONTAINER" /var/www/FreshRSS/cli/access-permissions.sh 2>&1 | sed 's/^/    /'

echo "==> Done. Login: $USER  API password: $API"
echo "==> Verify with: curl -s -X POST $BASE_URL/api/greader.php/accounts/ClientLogin -d Email=$USER -d Passwd=$API"
