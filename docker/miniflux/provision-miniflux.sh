#!/usr/bin/env bash
# Provision a single-user Miniflux instance for the Google Reader API tests.
#
# Idempotent. Run after:
#   docker compose -f docker/miniflux/docker-compose.yml up -d
#
# Creates/enables Google Reader credentials:
#   user     alice
#   password alicegr
set -euo pipefail

BASE_URL="${MINIFLUX_BASE_URL:-http://localhost:8081}"
USER="${MINIFLUX_USER:-alice}"
PASS="${MINIFLUX_PASS:-alicepass}"
GREADER_USER="${MINIFLUX_GREADER_USER:-alice}"
GREADER_PASS="${MINIFLUX_GREADER_PASS:-alicegr}"

jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

echo "==> Waiting for Miniflux at $BASE_URL..."
until curl -fsS "$BASE_URL/healthcheck" >/dev/null 2>&1; do
  sleep 1
done

csrf="$(curl -fsS -c "$jar" -b "$jar" "$BASE_URL/" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1)"
if [[ -z "$csrf" ]]; then
  echo "Could not obtain login CSRF token" >&2
  exit 1
fi

curl -fsS -c "$jar" -b "$jar" -X POST "$BASE_URL/login" \
  --data-urlencode "csrf=$csrf" \
  --data-urlencode "username=$USER" \
  --data-urlencode "password=$PASS" >/dev/null

csrf="$(curl -fsS -b "$jar" "$BASE_URL/integrations" | sed -n 's/.*name="csrf" value="\([^"]*\)".*/\1/p' | head -1)"
if [[ -z "$csrf" ]]; then
  echo "Could not obtain integrations CSRF token (login failed?)" >&2
  exit 1
fi

echo "==> Enabling Google Reader integration..."
curl -fsS -b "$jar" -X POST "$BASE_URL/integration" \
  --data-urlencode "csrf=$csrf" \
  --data-urlencode "googlereader_enabled=1" \
  --data-urlencode "googlereader_username=$GREADER_USER" \
  --data-urlencode "googlereader_password=$GREADER_PASS" \
  --data-urlencode "linktaco_visibility=PUBLIC" >/dev/null

echo "==> Done. Google Reader login: $GREADER_USER / $GREADER_PASS"
echo "==> Verify with: curl -s -X POST $BASE_URL/accounts/ClientLogin -d Email=$GREADER_USER -d Passwd=$GREADER_PASS"
