# Wiring MIO to Varta

MIO writes product events as JSON lines on stdout (see [analytics.md](../analytics.md)). Varta's
collector on the Docker host tails the container logs and sends those lines to one panel. MIO never
calls Varta at runtime, and no service here needs an endpoint, a token or a Varta SDK.

```
service stdout (JSON line, "kind":"product_event")
  -> Docker json-file log on the host
  -> Varta collector (file_log on /var/lib/docker/containers/*/*-json.log*)
  -> OpenObserve stream `product_events`  (all other lines go to stream `default`)
```

## What MIO provides

`docker-compose.varta.yml` is an optional override. The default `docker compose up` does not read it.

```sh
docker compose -f docker-compose.yml -f docker-compose.varta.yml up -d
```

For `identity`, `engagement`, `payments` and `web` (the four services that emit events) it adds:

| Setting               | Value                        | Why                                                                                    |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| label `varta.project` | `ex-mio`                     | the project Varta's observability layer writes on each event, from the container label |
| label `varta.service` | the service name             | the service stamped next to it                                                         |
| `logging.driver`      | `json-file`, 10 MB x 3 files | Varta only tails `json-file` logs, live and rotated                                    |

No ports, networks or environment variables change. Check the merged file with
`docker compose -f docker-compose.yml -f docker-compose.varta.yml config`.

Without the labels the events still arrive, but the project falls back to the compose project name,
which is the checkout directory's name. Use the override so the panel shows `ex-mio`.

## What the Varta side must have

- A collector on the same Docker host as the stack (the host agent, or the agent for a VPS without
  the deploy plane). Its log receiver reads `/var/lib/docker/containers/*/*-json.log` and the rotated
  `*-json.log.*` files, and routes any line whose JSON has `"kind":"product_event"` to the stream
  `product_events`.
- Attribution comes from the container labels, not from Varta's inventory: the observability layer
  reads `varta.project` and `varta.service` and writes them as `varta_project` and `varta_service`
  (the collector does not). An inventory row for `ex-mio` is not needed for attribution. A
  container younger than about a minute has no project yet, so its first lines carry none.
- Varta strips every `varta*` key a line carries itself, so MIO cannot set the project from the
  event body, only from the container label.

Generic hostnames used below: `<collector-host>` is the Docker host that runs the stack and the
collector; `<varta-panel>` is the Varta OpenObserve UI.

## Where the events land

Stream `product_events` (type logs) in the Varta OpenObserve. Every MIO event has
`kind = 'product_event'`, `event` (for example `payments.payment_succeeded`), `tenant_id`,
`varta_project = 'ex-mio'` and `varta_service`. The stream also holds one schema-seed record that is
not an event, so every query filters on `kind`.

## Column rules

Varta flattens `props` into columns named `props_<key>`. The rules, from Varta:

- Every value is a string (Utf8). Cast numbers before using them:
  `CAST(props_amount_minor AS DOUBLE)`.
- A key is not rewritten. A key that does not fit `^[a-z][a-z0-9_]*$` (camelCase, dots, over 64
  characters) is dropped, and the event gets `varta_props_dropped = true`.
- Also dropped, with the same flag: nested values, JSON text, arrays, nulls, email-shaped values
  under any key, `varta_`-prefixed keys and keys with a PII-named suffix. A `props` that is not a map
  is removed whole.
- Filter with `kind = 'product_event'` and `varta_project = 'ex-mio'`, using `=`, not `LIKE`.
- Count with `count(DISTINCT event_id)` or `count(DISTINCT varta_actor_key)`, never `count(*)`. On
  OpenObserve 0.14, `count(*)` over-counts even when no ingest is running, and the collector can
  re-read a line, so real duplicate rows exist too. `sum` over raw rows has the same problem.
  Distinct counts are the best available, not exact: Varta has not measured whether `DISTINCT` is
  immune to that surplus, nor whether a single scan can lose a row. Treat the numbers as approximate.
- Do not build a funnel as one SQL JOIN. Joins give wrong funnels on OpenObserve. Write one query
  per step and compute the step-to-step ratios outside the query, or by hand.

Every prop key MIO emits (see [analytics.md](../analytics.md)) is already flat `snake_case`, so
none is renamed or dropped: `role`, `environment`, `rotated`, `sandbox`, `new_player`, `launched`,
`plan_code`, `amount_minor`, `currency`, `reason`, `casino`, `source`, `coins`, `reward_coins`,
`price_coins`, `status`.

## Funnel queries

A computed funnel (ordered steps, conversion per step) is Varta VAR-5, which is pending. Until it
exists, run one query per step and divide by hand. Save the template in the panel (Logs, stream
`product_events`, SQL mode), changing only the event name:

```sql
SELECT count(DISTINCT varta_actor_key) AS actors
FROM "product_events"
WHERE kind = 'product_event'
  AND varta_project = 'ex-mio'
  AND event = 'identity.operator_signed_up'
```

The actor differs by step, and `varta_actor_key` includes the actor type, so a player, an operator
and the `payments` service are different actors by construction. Count by actor only where every
step of the funnel has the same kind of actor (the player funnel). Operator funnels count
`count(DISTINCT tenant_id)` instead. To count events themselves, use `count(DISTINCT event_id)`.
If MIO runs on more than one collector host, add a `host_name` predicate to every query here, or
the counts of the hosts merge. The tenant view of the same step:

```sql
SELECT tenant_id, count(DISTINCT event_id) AS events
FROM "product_events"
WHERE kind = 'product_event'
  AND varta_project = 'ex-mio'
  AND event = 'payments.payment_succeeded'
GROUP BY tenant_id
```

Steps, one query each, event names from [analytics.md](../analytics.md):

| Funnel              | Steps, in order                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator activation | `identity.operator_signed_up`, `identity.credential_issued`, `engagement.deposit_ingested`. Count `DISTINCT tenant_id` at every step: the first two actors are the operator, the third is a player.                                                                                                                                                                                                                                                                                       |
| Operator revenue    | `payments.plan_selected`, `payments.payment_succeeded`. Count `DISTINCT tenant_id`: the first actor is the operator, the second can be the operator or the `payments` service (a provider webhook has no caller).                                                                                                                                                                                                                                                                         |
| Player loop         | `web.widget_opened`, `identity.player_launched`, `engagement.deposit_ingested`, `engagement.spin_completed`, `payments.coins_credited`, `engagement.redemption_requested`, `engagement.redemption_resolved`. Count `DISTINCT varta_actor_key` from `player_launched` on (the actor is the player at each of those steps). `widget_opened` is an anonymous visitor before launch (a different population, never merged with the player) and the player after it; read it as its own count. |

Money: `payments.payment_succeeded` has no `sandbox` prop (it is the operator's plan billing, see
[analytics.md](../analytics.md)), so do not filter on `props_sandbox` there: the filter would match
nothing. Never `sum` raw rows (a collector re-read or a double scan duplicates rows). Deduplicate by
`event_id` first, and group by currency so two currencies are never added together:

```sql
SELECT props_currency, sum(amount) AS amount_minor
FROM (
  SELECT event_id, props_currency, max(CAST(props_amount_minor AS BIGINT)) AS amount
  FROM "product_events"
  WHERE kind = 'product_event'
    AND varta_project = 'ex-mio'
    AND event = 'payments.payment_succeeded'
  GROUP BY event_id, props_currency
)
GROUP BY props_currency
```

Where a query does filter on `sandbox` (the player events that carry it), the value is a string:
`props_sandbox = 'false'`.

## Screenshot steps for the demo

Run once the demo has been run against pre-prod with the override. Review every image before it is
published; blur hostnames, tenant ids and anything else internal.

1. Start the stack with the override (`docker compose ... up -d --wait`) and wait at least 70
   seconds before running `scripts/demo.sh`: a container younger than about 60 seconds is not yet
   attributed to its project, so the earliest events (sign-ups, plans) would carry no `varta_project`
   and every query below would miss them. Then run `scripts/demo.sh` and wait about a minute more
   for the lines to arrive.
2. Open `<varta-panel>`, log in, go to Logs.
3. Pick stream `product_events`, set the time range to cover the demo run.
4. Switch to SQL mode and run the per-step query once for each step of "Operator activation".
   Capture each result, or the three together.
5. Do the same for the "Player loop" steps.
6. Run the tenant view for `payments.payment_succeeded`. Capture it.
7. Capture one raw row (expand it) to show the envelope: `event`, `event_v`, `tenant_id`,
   `varta_project`, `varta_service`. Check that no email, token or key shows.
8. Hand the images to the owner; nothing is published before that review.
