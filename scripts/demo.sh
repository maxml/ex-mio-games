#!/usr/bin/env bash
# End-to-end demo of the MIO money story against a running `docker compose up` stack.
#
# Needs: bash 4+, curl, jq, openssl. Nothing else. Every step prints a heading, the request and the
# trimmed response, then asserts the expected status and fields; the first mismatch prints the
# request and the full response and exits non-zero.
#
# Public routes only. (The two database steps of the first version are gone: the wheel and rule are
# published with PUT /v1/operator/wheel and /rules, the provider subscription id is read from
# GET /v1/operator/plan, and the casino reward API is registered with PUT
# /v1/operator/integrations/:casino/reward-api.)
#
# Usage:   docker compose -p demo up -d --wait && scripts/demo.sh
# Env:     COMPOSE_PROJECT (default "demo"), *_PORT (same names compose uses), DEMO_SLUG_SUFFIX.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IDN="http://localhost:${IDENTITY_PORT:-4001}"
ENG="http://localhost:${ENGAGEMENT_PORT:-4002}"
PAY="http://localhost:${PAYMENTS_PORT:-4003}"
SIM="http://localhost:${CASINO_SIM_PORT:-4004}"
WEB="http://localhost:${WEB_PORT:-3000}"
# Addresses of the services as the casino simulator sees them (inside the compose network).
ENG_INTERNAL="http://engagement:4002"
SIM_INTERNAL="http://casino-sim:4004"
COMPOSE=(docker compose -p "${COMPOSE_PROJECT:-demo}")
PG_PASSWORD="${POSTGRES_PASSWORD:-postgres-dev}"
# Local-development value from docker-compose.yml (payments: FAKE_PROVIDER_WEBHOOK_SECRET).
FAKE_PROVIDER_SECRET="${FAKE_PROVIDER_WEBHOOK_SECRET:-dev-fake-provider-webhook-secret-0000}"
PASSWORD='correct horse battery'
SUF="${DEMO_SLUG_SUFFIX:-$(date +%s | tail -c 6)}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASSES=0
SOFT_FAILS=0
FAILED_STEPS=()
STEP=0
STATUS=""
BODY=""
HEADERS=""
LAST_REQ=""

declare -A TID SLUG TOK_ID TOK_PAY OP_ENG KEY_ID HMAC PLAT

# ---- output helpers -------------------------------------------------------------------------------

REDACT='walk(if type=="object" then with_entries(if (.key|test("^(access_token|api_key|hmac_secret|ticket|token|secret|password|card_number)$")) then .value="<redacted>" else . end) else . end)'

trim() { # trim one-line JSON (or text) to N chars
  local max="${1:-420}" s
  s="$(cat)"
  if [ "${#s}" -gt "$max" ]; then printf '%s ...(%d chars)\n' "${s:0:$max}" "${#s}"; else printf '%s\n' "$s"; fi
}
show_json() { # $1 = text; redacts secrets, compacts, trims
  if jq -e . >/dev/null 2>&1 <<<"$1"; then jq -c "$REDACT" <<<"$1" | trim; else printf '%s\n' "$1" | trim; fi
}
heading() { STEP=$((STEP + 1)); printf '\n=== Step %02d. %s\n' "$STEP" "$1"; }
note() { printf '    note: %s\n' "$*"; }
pass() { PASSES=$((PASSES + 1)); printf '    PASS  %s\n' "$*"; }
fail() {
  printf '\n    FAIL  %s\n' "$*" >&2
  printf '    last request : %s\n    last status  : %s\n    last response: %s\n' "$LAST_REQ" "$STATUS" "$(show_json "$BODY")" >&2
  if [ "${KEEP_GOING:-0}" = 1 ]; then
    # Evidence mode: record the failure, run the remaining steps, exit non-zero at the end.
    SOFT_FAILS=$((SOFT_FAILS + 1))
    FAILED_STEPS+=("step $STEP: $*")
    return 0
  fi
  exit 1
}

# call METHOD URL [curl args]: sets STATUS BODY HEADERS and prints the request and the trimmed response.
call() {
  local method="$1" url="$2" prev="" a desc="$1 ${2#http://localhost:}" shown=""
  shift 2
  for a in "$@"; do
    case "$prev" in
      -d) shown+=" body=$(jq -c "$REDACT" <<<"$a" 2>/dev/null || printf '%s' "$a")" ;;
      -H)
        case "${a,,}" in
          authorization:*) shown+=" [authorization: Bearer <redacted>]" ;;
          *) shown+=" [$a]" ;;
        esac
        ;;
    esac
    prev="$a"
  done
  LAST_REQ="$desc$shown"
  printf '  > %s\n' "$(printf '%s' "$LAST_REQ" | trim 300)"
  STATUS="$(curl -sS -m "${CALL_TIMEOUT:-40}" -X "$method" -o "$WORK/body" -D "$WORK/hdr" -w '%{http_code}' "$url" "$@" 2>"$WORK/err")" || STATUS="000"
  BODY="$(cat "$WORK/body" 2>/dev/null)"
  HEADERS="$(tr -d '\r' <"$WORK/hdr" 2>/dev/null)"
  printf '  < %s %s\n' "$STATUS" "$(show_json "$BODY")"
}
quiet() { curl -sS -m 25 "$@" 2>/dev/null; } # no printing, used inside polling loops

expect_status() { if [ "$STATUS" = "$1" ]; then pass "HTTP $1"; else fail "expected HTTP $1, got $STATUS"; fi; }
expect_jq() { if jq -e "$1" <<<"$BODY" >/dev/null 2>&1; then pass "$1"; else fail "expected response to satisfy: $1"; fi; }
expect_eq() { if [ "$2" = "$3" ]; then pass "$1 = $3"; else fail "$1: expected '$3', got '$2'"; fi; }
jqr() { jq -r "$1" <<<"$BODY"; }

wait_for() { # wait_for "what" seconds 'expression' ['diagnostic command']  (expression is evaluated on every try; quiet)
  local what="$1" secs="$2" end
  end=$((SECONDS + secs))
  until eval "$3"; do
    if [ "$SECONDS" -ge "$end" ]; then
      [ -n "${4:-}" ] && eval "$4"
      fail "timed out after ${secs}s waiting for: $what"
      return 0
    fi
    sleep 1
  done
}

# ---- crypto helpers (openssl only) ----------------------------------------------------------------

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
hmac_hex() { printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" -hex | awk '{print $NF}'; }

# A casino signs a launch token with the key issued to the operator (HS256, kid = key id).
launch_token() { # key_id secret platform external_player_id
  local now h p s
  now="$(date +%s)"
  h="$(printf '{"alg":"HS256","typ":"JWT","kid":"%s"}' "$1" | b64url)"
  p="$(jq -nc --arg pid "$4" --arg plat "$3" --argjson now "$now" --arg jti "demo-$RANDOM$RANDOM-$now" \
    '{pid:$pid,plat:$plat,aud:"mio-launch",iat:$now,exp:($now+120),jti:$jti}' | b64url)"
  s="$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$2" -binary | b64url)"
  printf '%s.%s.%s' "$h" "$p" "$s"
}

# ---- small domain helpers -------------------------------------------------------------------------

auth() { printf 'authorization: Bearer %s' "$1"; }
spins_of() { quiet "$ENG/v1/me/spins" -H "$(auth "$1")" | jq -r '.available // empty'; }
balance_of() { quiet "$PAY/v1/me/balance" -H "$(auth "$1")" | jq -r '.available // empty'; }
# stable_balance TOKEN: credits arrive over the bus, so a baseline read right after a spin can be stale.
# Polls until two reads 1 s apart are equal (15 s timeout) and prints that value.
stable_balance() {
  local prev cur end=$((SECONDS + 15))
  prev="$(balance_of "$1")"
  while :; do
    sleep 1
    cur="$(balance_of "$1")"
    if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then printf '%s' "$cur"; return 0; fi
    if [ "$SECONDS" -ge "$end" ]; then
      fail "balance did not settle within 15s (last reads '$prev' then '$cur')" >&2
      printf '%s' "$cur"
      return 0
    fi
    prev="$cur"
  done
}
redemption_state() { quiet "$ENG/v1/redemptions/$2" -H "$(auth "$1")" | jq -r '.state // empty'; }
is_final() { [ "$1" = ISSUED ] || [ "$1" = COMPLETED ]; }

# launch X external_id -> LAUNCH_ENG LAUNCH_PAY LAUNCH_USER (engagement and payments player tokens)
launch() {
  local x="$1" ext="$2" tok
  tok="$(launch_token "${KEY_ID[$x]}" "${HMAC[$x]}" "${PLAT[$x]}" "$ext")"
  call POST "$IDN/v1/auth/launch" -H 'content-type: application/json' -d "$(jq -nc --arg t "$tok" '{token:$t,audience:"engagement"}')"
  expect_status 200
  LAUNCH_ENG="$(jqr .access_token)"
  LAUNCH_USER="$(jqr .user_id)"
  expect_eq "launched tenant" "$(jqr .tenant_id)" "${TID[$x]}"
  tok="$(launch_token "${KEY_ID[$x]}" "${HMAC[$x]}" "${PLAT[$x]}" "$ext")" # a launch token is single-use
  call POST "$IDN/v1/auth/launch" -H 'content-type: application/json' -d "$(jq -nc --arg t "$tok" '{token:$t,audience:"payments"}')"
  expect_status 200
  LAUNCH_PAY="$(jqr .access_token)"
}

# sim_deposit X external_player event_id [extra sim fields as JSON]  -> the simulator signs and delivers
sim_deposit() {
  local x="$1" ext="$2" eid="$3" amount="${4:-5000}"
  call POST "$SIM/casino-${x,,}/__deposit" -H 'content-type: application/json' -d "$(jq -nc \
    --arg url "$ENG_INTERNAL/v1/integrations/${SLUG[$x]}/events" --arg secret "${HMAC[$x]}" \
    --arg p "$ext" --arg e "$eid" --argjson amt "$amount" \
    '{target_url:$url,secret:$secret,player_id:$p,amount_minor:$amt,currency:"EUR",event_id:$e}')"
}

# ====================================================================================================
printf 'MIO Games demo, run suffix %s\n' "$SUF"

heading "Stack is up: every service answers readiness"
for pair in "identity:$IDN" "engagement:$ENG" "payments:$PAY" "casino-sim:$SIM"; do
  call GET "${pair#*:}/healthz/ready"
  expect_status 200
  expect_jq '.status=="ok"'
done
call GET "$WEB/health"
expect_status 200
call POST "$SIM/__reset"
expect_status 200

# ---- Part B setup: two operators, plan, integration credentials ------------------------------------

for X in A B; do
  SLUG[$X]="demo-${X,,}-$SUF"
  PLAT[$X]="casino-${X,,}"

  heading "Casino $X operator signs up (creates tenant ${SLUG[$X]} and its first admin)"
  call POST "$IDN/v1/operators/signup" -H 'content-type: application/json' -H 'host: localhost' \
    -d "$(jq -nc --arg s "${SLUG[$X]}" --arg pw "$PASSWORD" '{tenant_name:("Casino "+$s),slug:$s,email:("boss@"+$s+".test"),password:$pw}')"
  expect_status 201
  expect_jq '.tenant.type=="operator" and .tenant.status=="active"'
  TID[$X]="$(jqr .tenant.id)"

  for aud in identity payments engagement; do
    call POST "$IDN/v1/auth/login" -H 'content-type: application/json' -H "host: ${SLUG[$X]}.mio.localhost" \
      -d "$(jq -nc --arg e "boss@${SLUG[$X]}.test" --arg pw "$PASSWORD" --arg a "$aud" '{email:$e,password:$pw,audience:$a}')"
    expect_status 200
    case "$aud" in
      identity) TOK_ID[$X]="$(jqr .access_token)" ;;
      payments) TOK_PAY[$X]="$(jqr .access_token)" ;;
      engagement) OP_ENG[$X]="$(jqr .access_token)" ;;
    esac
  done
done

for X in A B; do
  heading "Casino $X operator picks the Pro plan and pays with the fake provider (test card 4242...)"
  call GET "$PAY/v1/billing/plans" -H "$(auth "${TOK_PAY[$X]}")"
  expect_status 200
  expect_jq 'map(.code)|index("pro")!=null'
  PLAN_ID="$(jq -r '.[]|select(.code=="pro").id' <<<"$BODY")"
  call POST "$PAY/v1/billing/attempts" -H 'content-type: application/json' -H "$(auth "${TOK_PAY[$X]}")" \
    -H "idempotency-key: plan-$SUF-$X" -d "$(jq -nc --arg p "$PLAN_ID" '{plan_id:$p,card_number:"4242424242424242"}')"
  expect_status 201
  expect_jq '.state=="processing" and .card_last4=="4242"'
  ATTEMPT_ID="$(jqr .id)"
  SUB_ID="$(jqr .subscription_id)"

  note "the provider's callback carries ITS subscription id; the operator reads it from GET /v1/operator/plan, then signs the callback like the provider does."
  call GET "$PAY/v1/operator/plan" -H "$(auth "${TOK_PAY[$X]}")"
  expect_status 200
  expect_eq "plan subscription" "$(jqr .subscription_id)" "$SUB_ID"
  PROVIDER_SUB="$(jqr .provider_subscription_id)"
  [ -n "$PROVIDER_SUB" ] || fail "no provider subscription id for $SUB_ID"
  WEBHOOK="$(jq -nc --arg t "${TID[$X]}" --arg s "$PROVIDER_SUB" --arg e "evt-$SUF-$X" \
    '{eventId:$e,tenantId:$t,subscriptionId:$s,status:"active",version:1,amountMinor:4900,currency:"USD",periodStart:"2026-11-01T00:00:00.000Z",periodEnd:"2026-12-01T00:00:00.000Z"}')"
  call POST "$PAY/v1/billing/webhooks" -H 'content-type: application/json' -H "x-webhook-signature: $(hmac_hex "$FAKE_PROVIDER_SECRET" "$WEBHOOK")" -d "$WEBHOOK"
  expect_status 200
  expect_jq '.outcome=="applied"'
  call GET "$PAY/v1/billing/attempts/$ATTEMPT_ID" -H "$(auth "${TOK_PAY[$X]}")"
  expect_status 200
  expect_jq '.state=="succeeded"'
  call GET "$PAY/v1/billing/subscription" -H "$(auth "${TOK_PAY[$X]}")"
  expect_status 200
  expect_jq '.status=="active"'

  heading "Casino $X integration credentials (key id, API key, HMAC secret shown once)"
  call POST "$IDN/v1/credentials" -H 'content-type: application/json' -H "$(auth "${TOK_ID[$X]}")" -d "$(jq -nc --arg p "${PLAT[$X]}" '{platform:$p,environment:"production"}')"
  expect_status 201
  expect_jq '(.key_id|length)>0 and (.hmac_secret|length)>0 and (.api_key|length)>0'
  KEY_ID[$X]="$(jqr .key_id)"
  HMAC[$X]="$(jqr .hmac_secret)"

  heading "Casino $X: the engagement service built its tenant copy from the bus event"
  wait_for "tenant projection of $X" 30 '[ -n "$(quiet "$ENG/v1/tenant-projection" -H "$(auth "${OP_ENG[$X]}")" | jq -r ".slug // empty")" ]'
  call GET "$ENG/v1/tenant-projection" -H "$(auth "${OP_ENG[$X]}")"
  expect_status 200
  expect_jq ".slug==\"${SLUG[$X]}\""

  heading "Casino $X operator registers its reward API (casino-sim, production) so MIO can issue bonuses"
  call PUT "$IDN/v1/operator/integrations/${PLAT[$X]}/reward-api" -H 'content-type: application/json' -H "$(auth "${TOK_ID[$X]}")" \
    -d "$(jq -nc --arg u "$SIM_INTERNAL" --arg k "demo-reward-key-${X,,}" '{environment:"production",base_url:$u,api_key:$k}')"
  note "no route of the stack answers with the secret again; it is sealed at rest and served to engagement only."
  expect_status 200
  expect_jq '.has_api_key==true and (has("api_key")|not)'

  heading "Casino $X operator publishes one weighted reward table and one deposit rule (deposit >= 20.00 EUR gives 1 spin)"
  note "A new tenant already has a default wheel and rule; the operator replaces them with the next version."
  TABLE='{"name":"Demo wheel","segments":[{"label":"200 coins","weight":6,"reward":{"type":"coins","amount":200}},{"label":"300 coins","weight":3,"reward":{"type":"coins","amount":300}},{"label":"500 coins","weight":1,"reward":{"type":"coins","amount":500}}]}'
  call PUT "$ENG/v1/operator/wheel" -H 'content-type: application/json' -H "$(auth "${OP_ENG[$X]}")" -d "$TABLE"
  expect_status 200
  expect_jq '.version>=2'
  call PUT "$ENG/v1/operator/rules" -H 'content-type: application/json' -H "$(auth "${OP_ENG[$X]}")" \
    -d '{"name":"Deposit 20 EUR, 1 spin","min_amount_minor":2000,"currency":"EUR","spins":1}'
  expect_status 200
  expect_jq '.version>=2'
  pass "rule and reward table published for ${SLUG[$X]}"
done

heading "Casino A operator adds a Bonus Store item (50 coins for a 5.00 EUR bonus)"
call POST "$ENG/v1/store/items" -H 'content-type: application/json' -H "$(auth "${OP_ENG[A]}")" \
  -d '{"name":"5 EUR bonus","description":"Bonus credited to the casino wallet","price":50,"reward":{"type":"bonus","params":{"amount_minor":500,"currency":"EUR"}}}'
expect_status 201
ITEM_A="$(jqr .id)"
heading "Casino B operator adds a Bonus Store item"
call POST "$ENG/v1/store/items" -H 'content-type: application/json' -H "$(auth "${OP_ENG[B]}")" \
  -d '{"name":"5 EUR bonus","description":"Bonus credited to the casino wallet","price":50,"reward":{"type":"bonus","params":{"amount_minor":500,"currency":"EUR"}}}'
expect_status 201
ITEM_B="$(jqr .id)"

# ---- Steps 1-3: deposit -> validated -> one spin ---------------------------------------------------

heading "Casino A (schema A: eventId/playerId/amount.value, HMAC over timestamp.body): casino-sim sends a signed 50.00 EUR deposit"
EXT_A="A-PLAYER-77"
sim_deposit A "$EXT_A" "evt-a-$SUF-1"
expect_status 200
expect_jq '.delivered==[200]'

heading "Casino B (schema B: type/data.txn_id/customer_ref, signature inside the body): casino-sim sends a signed 50.00 EUR deposit"
EXT_B="B-PLAYER-12"
sim_deposit B "$EXT_B" "evt-b-$SUF-1"
expect_status 200
expect_jq '.delivered==[200]'

heading "Player A launches from casino A with a signed launch token"
launch A "$EXT_A"
PA_ENG="$LAUNCH_ENG"; PA_PAY="$LAUNCH_PAY"; PA_USER="$LAUNCH_USER"
heading "Player B launches from casino B"
launch B "$EXT_B"
PB_ENG="$LAUNCH_ENG"; PB_PAY="$LAUNCH_PAY"; PB_USER="$LAUNCH_USER"

for X in A B; do
  eval "T=\$P${X}_ENG"
  heading "Casino $X player holds exactly one spin credit (granted over the bus by the rules engine)"
  wait_for "spin credit of $X" 40 '[ "$(spins_of "$T")" = 1 ]'
  call GET "$ENG/v1/me/spins" -H "$(auth "$T")"
  expect_status 200
  expect_jq '.available==1'
done

# ---- Realtime: one Socket.IO client through the web origin ------------------------------------------

heading "Realtime: Socket.IO client on the WEB origin (/socket.io is rewritten by Next to engagement), one-time ticket"
call POST "$IDN/v1/auth/realtime-ticket" -H 'content-type: application/json' -H "$(auth "$PA_ENG")" -d '{}'
expect_status 200
TICKET="$(jqr .ticket)"
SLASH_HEAD="$(curl -s -m 10 -o /dev/null -D - "$WEB/socket.io/?EIO=4&transport=polling" | tr -d '\r' | grep -i -E '^(HTTP|location)' | tr '\n' ' ')"
printf '  > GET /socket.io/?EIO=4&transport=polling (the URL the socket.io client uses, trailing slash)\n  < %s\n' "$SLASH_HEAD"
soft_fail() { SOFT_FAILS=$((SOFT_FAILS + 1)); FAILED_STEPS+=("step $STEP: $*"); printf '    FAIL  %s\n' "$*"; }
WEB_RT=0
EIO="$WEB/socket.io?EIO=4"
HS="$(quiet "$EIO&transport=polling")"
printf '  > GET /socket.io?EIO=4&transport=polling (web origin, after following the redirect)\n  < %s\n' "$(printf '%s' "$HS" | trim 200)"
SID="$(printf '%s' "$HS" | sed -n 's/^0//p' | jq -r '.sid // empty' 2>/dev/null)"
if [ -n "$SID" ]; then
  WEB_RT=1
  pass "engine.io handshake through the web origin over HTTP long-polling"
else
  soft_fail "no Socket.IO handshake through the web origin: Next redirects /socket.io/ to /socket.io (308) and the proxied path without the slash is a 404 at engagement"
  note "falling back to engagement's own origin for the rest of the realtime check, so the push itself is still shown"
  EIO="$ENG/socket.io/?EIO=4"
  HS="$(quiet "$EIO&transport=polling")"
  printf '  > GET %s (engagement origin, direct)\n  < %s\n' "/socket.io/?EIO=4&transport=polling" "$(printf '%s' "$HS" | trim 200)"
  SID="$(printf '%s' "$HS" | sed -n 's/^0//p' | jq -r '.sid // empty' 2>/dev/null)"
  [ -n "$SID" ] || fail "no Socket.IO handshake on engagement's own origin either"
  pass "engine.io handshake on engagement directly over HTTP long-polling"
fi
OPEN="$(printf '40/rt,%s' "$(jq -nc --arg t "$TICKET" '{token:$t}')")"
R="$(quiet -X POST "$EIO&transport=polling&sid=$SID" -H 'content-type: text/plain;charset=UTF-8' --data-binary "$OPEN")"
expect_eq "namespace connect packet accepted" "$R" "ok"
R="$(quiet "$EIO&transport=polling&sid=$SID" | tr '\036' '\n')"
printf '  < %s\n' "$(printf '%s' "$R" | trim 200)"
printf '%s' "$R" | grep -q '^40/rt,{"sid"' || fail "namespace /rt refused the ticket: $R"
pass "connected to namespace /rt with the ticket (long-polling transport)"

heading "Realtime: does the WebSocket upgrade also pass through the Next proxy?"
ws_probe() { # base-url-with-?EIO=4 : handshake by polling, then ask for the upgrade; prints the status line
  local base="$1" hs sid
  hs="$(quiet "$base&transport=polling")"
  sid="$(printf '%s' "$hs" | sed -n 's/^0//p' | jq -r '.sid // empty' 2>/dev/null)"
  curl -s -m 4 -o /dev/null -D - --http1.1 "$base&transport=websocket&sid=$sid" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | openssl base64)" 2>/dev/null | tr -d '\r' | head -1
}
WS_PLAIN="$(ws_probe "$WEB/socket.io?EIO=4")"
WS_SLASH="$(curl -s -m 4 -o /dev/null -D - --http1.1 "$WEB/socket.io/?EIO=4&transport=websocket" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | openssl base64)" 2>/dev/null | tr -d '\r' | head -1)"
printf '  > GET /socket.io?EIO=4&transport=websocket&sid=<sid>  + Upgrade: websocket (web origin, no trailing slash)\n  < %s\n' "${WS_PLAIN:-no response}"
printf '  > GET /socket.io/?EIO=4&transport=websocket + Upgrade: websocket (web origin, trailing slash as the client sends it)\n  < %s\n' "${WS_SLASH:-no response}"
res() { case "$1" in *" 101 "*) echo "upgraded (101 Switching Protocols)" ;; *) echo "FAILED: ${1:-no response}" ;; esac; }
WS_DIRECT="$(curl -s -m 4 -o /dev/null -D - --http1.1 "$ENG/socket.io/?EIO=4&transport=websocket" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | openssl base64)" 2>/dev/null | tr -d '\r' | head -1)"
printf '  > GET /socket.io/?EIO=4&transport=websocket + Upgrade: websocket (engagement origin, direct, for comparison)\n  < %s\n' "${WS_DIRECT:-no response}"
printf '    WEBSOCKET_THROUGH_NEXT_PROXY (no slash): %s\n' "$(res "$WS_PLAIN")"
printf '    WEBSOCKET_THROUGH_NEXT_PROXY (trailing slash): %s\n' "$(res "$WS_SLASH")"
printf '    WEBSOCKET_ON_ENGAGEMENT_DIRECT: %s\n' "$(res "$WS_DIRECT")"
if [ "$WEB_RT" = 1 ]; then
  printf '    LONG_POLLING_THROUGH_NEXT_PROXY: works (handshake, namespace connect and the packet poll above)\n'
else
  printf '    LONG_POLLING_THROUGH_NEXT_PROXY: FAILED (see the handshake step above)\n'
  soft_fail "realtime through the web origin: neither long-polling nor the websocket upgrade works through the Next rewrite"
fi

# ---- Steps 4-5: spin and balance -----------------------------------------------------------------------

heading "Player A spins the wheel: server-authoritative result from the configured weighted table"
call GET "$ENG/v1/wheel" -H "$(auth "$PA_ENG")"
expect_status 200
expect_jq '(.segments|length)==3 and (.segments[0]|has("weight")|not)'
call POST "$ENG/v1/spins" -H 'content-type: application/json' -H "$(auth "$PA_ENG")" -H "idempotency-key: spin-a-$SUF-1" -d '{}'
expect_status 201
expect_jq '.reward_coins as $c | [200,300,500]|index($c)!=null'
REWARD_A="$(jqr .reward_coins)"
SPIN_A_ID="$(jqr .spin_id)"
call POST "$ENG/v1/spins" -H 'content-type: application/json' -H "$(auth "$PA_ENG")" -H "idempotency-key: spin-a-$SUF-1" -d '{}'
expect_status 201
expect_eq "same Idempotency-Key replays the same spin" "$(jqr .spin_id)" "$SPIN_A_ID"

heading "Player A's coin balance shows the reward (ledger credit arrives over the bus)"
wait_for "balance of A" 40 '[ "$(balance_of "$PA_PAY")" = "$REWARD_A" ]'
call GET "$PAY/v1/me/balance" -H "$(auth "$PA_PAY")"
expect_status 200
expect_jq ".available==$REWARD_A"

heading "Realtime: the pushed spin and balance events arrive on player A's socket"
FRAMES=""
for _ in 1 2 3 4; do
  FRAMES+="$(quiet -m 12 "$EIO&transport=polling&sid=$SID" | tr '\036' '\n' | grep '^42/rt,' || true)"$'\n'
  if grep -q 'spin.result' <<<"$FRAMES" && grep -q 'balance.changed' <<<"$FRAMES"; then break; fi
done
printf '%s' "$FRAMES" | sed '/^$/d' | while IFS= read -r l; do printf '  < %s\n' "$(printf '%s' "$l" | trim 300)"; done
grep -q '"spin.result"' <<<"$FRAMES" || fail "no spin.result frame was pushed"
pass "spin.result pushed over the socket"
grep -q '"balance.changed"' <<<"$FRAMES" || fail "no balance.changed frame was pushed"
pass "balance.changed pushed over the socket"

heading "Casino B player spins and sees the coins (same logic, other casino)"
call POST "$ENG/v1/spins" -H 'content-type: application/json' -H "$(auth "$PB_ENG")" -H "idempotency-key: spin-b-$SUF-1" -d '{}'
expect_status 201
REWARD_B="$(jqr .reward_coins)"
wait_for "balance of B" 40 '[ "$(balance_of "$PB_PAY")" = "$REWARD_B" ]'
call GET "$PAY/v1/me/balance" -H "$(auth "$PB_PAY")"
expect_status 200
expect_jq ".available==$REWARD_B"

# ---- Steps 6-8: redeem and track the final status ---------------------------------------------------------

heading "Bonus Store: player A lists items and redeems (50 coins)"
call GET "$ENG/v1/store/items" -H "$(auth "$PA_ENG")"
expect_status 200
expect_jq "map(.id)|index(\"$ITEM_A\")!=null"
call POST "$ENG/v1/redemptions" -H 'content-type: application/json' -H "$(auth "$PA_ENG")" -H "idempotency-key: redeem-a-$SUF-1" -d "{\"item_id\":\"$ITEM_A\"}"
expect_status 202
RED_A="$(jqr .id)"

heading "MIO asks casino A to issue the bonus through its adapter; the issuance reaches casino-sim"
wait_for "redemption A final" 60 'is_final "$(redemption_state "$PA_ENG" "$RED_A")"' 'call GET "$ENG/v1/operator/redemptions/$RED_A" -H "$(auth "${OP_ENG[A]}")"'
call GET "$ENG/v1/redemptions/$RED_A" -H "$(auth "$PA_ENG")"
expect_status 200
expect_jq '.status=="issued" and (.state=="ISSUED" or .state=="COMPLETED")'
call GET "$SIM/__issued?casino=a"
expect_status 200
expect_jq '[.[]|select(.player_id=="A-PLAYER-77")]|length==1'

heading "Casino B: the reward API is asynchronous (ticket), so the casino settles it and MIO tracks the final status"
call POST "$ENG/v1/redemptions" -H 'content-type: application/json' -H "$(auth "$PB_ENG")" -H "idempotency-key: redeem-b-$SUF-1" -d "{\"item_id\":\"$ITEM_B\"}"
expect_status 202
RED_B="$(jqr .id)"
wait_for "casino B ticket created" 20 'quiet "$SIM/__issued?casino=b" | jq -e "length>=1" >/dev/null'
call GET "$SIM/__issued?casino=b"
expect_status 200
call POST "$SIM/casino-b/__settle"
expect_status 200
wait_for "redemption B final" 60 'is_final "$(redemption_state "$PB_ENG" "$RED_B")"' 'call GET "$ENG/v1/operator/redemptions/$RED_B" -H "$(auth "${OP_ENG[B]}")"'
call GET "$ENG/v1/redemptions/$RED_B" -H "$(auth "$PB_ENG")"
expect_status 200
expect_jq '.status=="issued"'
call GET "$PAY/v1/me/balance" -H "$(auth "$PA_PAY")"
expect_jq ".available==$((REWARD_A - 50))"

heading "Operator console reads: tenant usage, redemptions, subscription"
call GET "$PAY/v1/billing/usage?period=$(date -u +%Y-%m)" -H "$(auth "${TOK_PAY[A]}")"
expect_status 200
expect_jq '.spins>=1 and .monthly_active_players>=1'
call GET "$ENG/v1/operator/redemptions" -H "$(auth "${OP_ENG[A]}")"
expect_status 200
expect_jq "map(.id)|index(\"$RED_A\")!=null"
call GET "$PAY/v1/players/$PA_USER/balance" -H "$(auth "${TOK_PAY[A]}")"
expect_status 200

# ---- Part C: reliability and security -----------------------------------------------------------------------

heading "Part C-1. Duplicate deposit: the casino delivers the same webhook 3 times, the player gets ONE spin"
BEFORE="$(spins_of "$PA_ENG")"
call POST "$SIM/__faults" -H 'content-type: application/json' -d '{"casino":"a","kind":"duplicateDelivery","times":1,"copies":3}'
expect_status 200
sim_deposit A "$EXT_A" "evt-a-$SUF-dup"
expect_status 200
expect_jq '.delivered==[200,200,200]'
wait_for "one new spin credit" 40 '[ "$(spins_of "$PA_ENG")" = "$((BEFORE + 1))" ]'
sleep 3
call GET "$ENG/v1/me/spins" -H "$(auth "$PA_ENG")"
expect_eq "spins after 3 identical deliveries" "$(jqr .available)" "$((BEFORE + 1))"

heading "Part C-2. Concurrent spins: 10 parallel requests, distinct keys, one credit: exactly one wins"
# One credit is available (from step C-1); a second unsent credit would hide a race, so check first.
CRED="$(spins_of "$PA_ENG")"
note "available credits before the race: $CRED"
printf '  > 10 x POST /v1/spins (distinct Idempotency-Key, in parallel)\n'
CODES="$(seq 1 10 | xargs -P 10 -I@@ curl -s -m 30 -o /dev/null -w '%{http_code}\n' -X POST "$ENG/v1/spins" \
  -H 'content-type: application/json' -H "authorization: Bearer $PA_ENG" -H "idempotency-key: race-$SUF-@@" -d '{}' | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
printf '  < %s\n' "$CODES"
WINS="$(grep -o '[0-9]* 201' <<<"$CODES" | cut -d' ' -f1)"
expect_eq "winners (HTTP 201) among 10 parallel spins on $CRED credit(s)" "${WINS:-0}" "$CRED"
call GET "$ENG/v1/me/spins" -H "$(auth "$PA_ENG")"
expect_jq '.available==0'

heading "Part C-3. Duplicate redemption: the same Idempotency-Key 5 times in parallel debits the coins once"
BAL0="$(stable_balance "$PA_PAY")"
printf '  > 5 x POST /v1/redemptions (same Idempotency-Key, in parallel)\n'
OUT="$(seq 1 5 | xargs -P 5 -I@@ curl -s -m 30 -X POST "$ENG/v1/redemptions" -H 'content-type: application/json' \
  -H "authorization: Bearer $PA_ENG" -H "idempotency-key: redeem-a-$SUF-dup" -d "{\"item_id\":\"$ITEM_A\"}" -w '\n%{http_code}\n')"
printf '  < statuses: %s\n' "$(grep -E '^[0-9]{3}$' <<<"$OUT" | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
IDS="$(grep '^{' <<<"$OUT" | jq -r 'select(.id)|.id' | sort -u)"
expect_eq "distinct redemption ids across the 5 requests" "$(wc -l <<<"$IDS" | tr -d ' ')" "1"
DUP_ID="$IDS"
call POST "$ENG/v1/redemptions" -H 'content-type: application/json' -H "$(auth "$PA_ENG")" -H "idempotency-key: redeem-a-$SUF-dup" -d "{\"item_id\":\"$ITEM_A\"}"
expect_status 202
expect_eq "replayed id" "$(jqr .id)" "$DUP_ID"
grep -qi '^idempotent-replayed: true' <<<"$HEADERS" && pass "Idempotent-Replayed: true header" || fail "no Idempotent-Replayed header on the replay"
wait_for "duplicate redemption final" 45 'is_final "$(redemption_state "$PA_ENG" "$DUP_ID")"' 'call GET "$ENG/v1/operator/redemptions/$DUP_ID" -H "$(auth "${OP_ENG[A]}")"'
expect_eq "coins debited once" "$(balance_of "$PA_PAY")" "$((BAL0 - 50))"
call GET "$SIM/__issued?casino=a"
expect_jq "[.[]|select(.player_id==\"A-PLAYER-77\")]|length==2"

heading "Part C-4. Casino timeout: the casino accepts the bonus but never answers in time -> UNKNOWN -> recovery by lookup"
call POST "$SIM/__faults" -H 'content-type: application/json' -d '{"casino":"a","kind":"timeout","times":1,"player_id":"A-PLAYER-77"}'
expect_status 200
call POST "$ENG/v1/redemptions" -H 'content-type: application/json' -H "$(auth "$PA_ENG")" -H "idempotency-key: redeem-a-$SUF-timeout" -d "{\"item_id\":\"$ITEM_A\"}"
expect_status 202
TO_ID="$(jqr .id)"
SEEN=""
end=$((SECONDS + 60))
while [ "$SECONDS" -lt "$end" ]; do
  S="$(redemption_state "$PA_ENG" "$TO_ID")"
  case " $SEEN " in *" $S "*) ;; *) SEEN="$SEEN $S"; printf '    state: %s\n' "$S" ;; esac
  case "$S" in ISSUED | COMPLETED) break ;; esac
  sleep 1
done
call GET "$ENG/v1/redemptions/$TO_ID" -H "$(auth "$PA_ENG")"
expect_status 200
expect_jq '.status=="issued"'
expect_jq '[.history[].to]|index("UNKNOWN")!=null'
call GET "$SIM/__issued?casino=a"
expect_jq "[.[]|select(.player_id==\"A-PLAYER-77\")]|length==3"
note "three redemptions, three issued rewards on the casino: the timeout produced no second reward"

heading "Part C-5. Invalid or unauthorized events are rejected and change nothing"
EVENT="$(jq -nc --argjson ts "$(date +%s)" '{eventId:"evt-forged-1",playerId:"A-PLAYER-77",amount:{value:5000,currency:"EUR"},status:"SUCCESS",ts:$ts}')"
call POST "$ENG/v1/integrations/${SLUG[A]}/events" -H 'content-type: application/json' -d "$EVENT"
expect_status 401
TS="$(date +%s)"
call POST "$ENG/v1/integrations/${SLUG[A]}/events" -H 'content-type: application/json' -H "x-a-timestamp: $TS" -H 'x-a-signature: 0000000000000000000000000000000000000000000000000000000000000000' -d "$EVENT"
expect_status 401
call POST "$ENG/v1/integrations/${SLUG[A]}/events" -H 'content-type: application/json' -H "x-a-timestamp: $TS" -H "x-a-signature: $(hmac_hex "${HMAC[B]}" "$TS.$EVENT")" -d "$EVENT"
expect_status 401
note "the last one is signed with casino B's secret: a valid signature of another tenant is still refused"
call GET "$ENG/v1/me/spins" -H "$(auth "$PA_ENG")"
expect_jq '.available==0'
call POST "$ENG/v1/spins" -H 'content-type: application/json' -H 'idempotency-key: no-token-1' -d '{}'
expect_status 401
note "a spin without a player token is refused; a player cannot name another user, the tenant or the odds in any request"

heading "Part C-6. Player isolation inside one casino: another player of casino A cannot read player A's data"
EXT_A2="A-PLAYER-88"
launch A "$EXT_A2"
PA2_ENG="$LAUNCH_ENG"; PA2_PAY="$LAUNCH_PAY"; PA2_USER="$LAUNCH_USER"
call GET "$ENG/v1/redemptions/$RED_A" -H "$(auth "$PA2_ENG")"
expect_status 404
call GET "$PAY/v1/players/$PA_USER/balance" -H "$(auth "$PA2_PAY")"
[ "$STATUS" = 403 ] || [ "$STATUS" = 404 ] || fail "expected 403/404 reading another player's balance, got $STATUS"
pass "another player's balance refused ($STATUS)"
call GET "$ENG/v1/me/redemptions" -H "$(auth "$PA2_ENG")"
expect_status 200
expect_jq 'length==0'
heading "Part C-6b. No negative balance: the same player with 0 coins tries to redeem"
call POST "$ENG/v1/redemptions" -H 'content-type: application/json' -H "$(auth "$PA2_ENG")" -H "idempotency-key: redeem-a2-$SUF-1" -d "{\"item_id\":\"$ITEM_A\"}"
expect_status 409
expect_jq '.code=="insufficient_funds"'
call GET "$PAY/v1/me/balance" -H "$(auth "$PA2_PAY")"
note "a player who never earned coins has no wallet yet (404 wallet_not_found); either answer means a balance of zero, never negative"
if [ "$STATUS" = 404 ]; then expect_jq '.code=="wallet_not_found"'; else expect_jq '.available==0'; fi

heading "Part C-7. Tenant isolation: casino B cannot see casino A's redemption, balance or webhook"
call GET "$ENG/v1/operator/redemptions/$RED_A" -H "$(auth "${OP_ENG[B]}")"
expect_status 404
call GET "$ENG/v1/redemptions/$RED_A" -H "$(auth "$PB_ENG")"
expect_status 404
call GET "$ENG/v1/operator/redemptions" -H "$(auth "${OP_ENG[B]}")"
expect_jq "map(.id)|index(\"$RED_A\")==null"
call GET "$PAY/v1/players/$PA_USER/balance" -H "$(auth "${TOK_PAY[B]}")"
[ "$STATUS" = 404 ] || [ "$STATUS" = 403 ] || fail "expected 404/403 for another tenant's player balance, got $STATUS"
pass "another tenant's player balance refused ($STATUS)"
call POST "$ENG/v1/integrations/${SLUG[B]}/events" -H 'content-type: application/json' -H "x-a-timestamp: $TS" -H "x-a-signature: $(hmac_hex "${HMAC[A]}" "$TS.$EVENT")" -d "$EVENT"
expect_status 401
call GET "$ENG/v1/tenant-projection" -H "$(auth "${OP_ENG[B]}")"
expect_jq ".slug==\"${SLUG[B]}\""

printf '\n=== DONE: %d steps, %d assertions passed, %d recorded failure(s)\n' "$STEP" "$PASSES" "$SOFT_FAILS"
if [ "$SOFT_FAILS" != 0 ]; then
  printf 'Recorded failures:\n'
  printf '  - %s\n' "${FAILED_STEPS[@]}"
  exit 1
fi
