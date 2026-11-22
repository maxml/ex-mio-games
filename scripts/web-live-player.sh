#!/usr/bin/env bash
# Opens the player widget of a tenant you set up in the operator console (live mode).
#
# The console covers signup, plan, credentials, rules, wheel and store items. Two things happen on the
# casino's side, and this script plays that casino against the compose stack:
#   1. the operator registers the casino's reward API (so redemptions can be issued), and
#   2. the casino sends a signed deposit for a player and signs a launch token for the widget.
#
# Usage: scripts/web-live-player.sh SLUG EMAIL PASSWORD KEY_ID HMAC_SECRET [PLAYER_ID] [DEPOSITS]
#   SLUG is the tenant slug (company name, lower case, dashes). KEY_ID and HMAC_SECRET are shown once on the
#   console's "Keys" step. Ports follow docker-compose.yml (override WEB_PORT, IDENTITY_PORT, ...).
set -euo pipefail
SLUG=${1:?slug}; EMAIL=${2:?email}; PASSWORD=${3:?password}; KEY_ID=${4:?key id}; HMAC=${5:?hmac secret}
PLAYER=${6:-player-1}; DEPOSITS=${7:-3}
WEB="http://localhost:${WEB_PORT:-3000}"
IDN="http://localhost:${IDENTITY_PORT:-4001}"
SIM="http://localhost:${CASINO_SIM_PORT:-4004}"
PLATFORM=casino-a   # the BFF issues credentials for this platform; casino-sim serves it at /casino-a

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

login() {
  curl -fsS -X POST "$IDN/v1/auth/login" -H "Host: $SLUG.mio.localhost" -H 'content-type: application/json' \
    -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" --arg a "$1" '{email:$e,password:$p,audience:$a}')" | jq -r .access_token
}

echo "1. registering the casino reward API (production first, then sandbox)"
OI=$(login identity)
for ENVIRONMENT in production sandbox; do
  curl -fsS -X PUT "$IDN/v1/operator/integrations/$PLATFORM/reward-api" -H 'content-type: application/json' \
    -H "authorization: Bearer $OI" \
    -d "{\"environment\":\"$ENVIRONMENT\",\"base_url\":\"http://casino-sim:4004\",\"api_key\":\"sim-reward-key\"}" >/dev/null
done

echo "2. the casino sends $DEPOSITS signed deposits of 50.00 EUR for $PLAYER (each earns spins by your rule)"
for _ in $(seq "$DEPOSITS"); do
  curl -fsS -X POST "$SIM/$PLATFORM/__deposit" -H 'content-type: application/json' \
    -d "$(jq -nc --arg url "http://engagement:4002/v1/integrations/$SLUG/events" --arg s "$HMAC" --arg p "$PLAYER" \
      --arg e "dep-$RANDOM$RANDOM" '{target_url:$url,secret:$s,player_id:$p,amount_minor:5000,currency:"EUR",event_id:$e}')" >/dev/null
done

echo "3. signing a launch token (single use, valid 2 minutes)"
now=$(date +%s)
h=$(printf '{"alg":"HS256","typ":"JWT","kid":"%s"}' "$KEY_ID" | b64url)
p=$(jq -nc --arg pid "$PLAYER" --arg plat "$PLATFORM" --argjson now "$now" --arg jti "j$RANDOM$RANDOM$now" \
  '{pid:$pid,plat:$plat,aud:"mio-launch",iat:$now,exp:($now+120),jti:$jti}' | b64url)
s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$HMAC" -binary | b64url)
echo
echo "Open the widget (within 2 minutes):"
echo "$WEB/en/embed/widget?token=$h.$p.$s"
