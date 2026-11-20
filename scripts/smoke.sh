#!/usr/bin/env bash
# Compose smoke test: all services healthy, round-robin across api instances, key pages reachable.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:8080}"
fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

for i in $(seq 1 60); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 2
  [ "$i" = 60 ] && fail "api not reachable via nginx"
done

code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
[ "$(code "$BASE/")" = 200 ] || fail "web / not 200"
[ "$(code "$BASE/docs")" = 200 ] || [ "$(code "$BASE/docs/")" = 200 ] || fail "/docs not 200"
[ "$(code "http://localhost:8025/")" = 200 ] || fail "mail stub UI not 200"

# Round-robin without stickiness: both instances must answer within a few requests.
seen=""
for _ in $(seq 1 10); do
  seen="$seen $(curl -fsS "$BASE/api/health" | sed -E 's/.*"instance":"([^"]+)".*/\1/')"
done
echo "$seen" | grep -q api1 || fail "api1 never served a request"
echo "$seen" | grep -q api2 || fail "api2 never served a request"

# WebSocket upgrade headers are forwarded (socket.io lands in stage 4; 404 from api is fine, 502 is not).
[ "$(code "$BASE/socket.io/?EIO=4&transport=polling")" != 502 ] || fail "nginx cannot reach api for /socket.io"

echo "SMOKE OK ($seen )"
