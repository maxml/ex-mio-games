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

| Setting | Value | Why |
| --- | --- | --- |
| label `varta.project` | `ex-mio` | the project the collector stamps on each event |
| label `varta.service` | the service name | the service stamped next to it |
| `logging.driver` | `json-file`, 10 MB x 3 files | Varta only tails `json-file` logs, live and rotated |

No ports, networks or environment variables change. Check the merged file with
`docker compose -f docker-compose.yml -f docker-compose.varta.yml config`.

Without the labels the events still arrive, but the project falls back to the compose project name,
which is the checkout directory's name. Use the override so the panel shows `ex-mio`.

## What the Varta side must have

- A collector on the same Docker host as the stack (the host agent, or the agent for a VPS without
  the deploy plane). Its log receiver reads `/var/lib/docker/containers/*/*-json.log` and the rotated
  `*-json.log.*` files, and routes any line whose JSON has `"kind":"product_event"` to the stream
  `product_events`.
- The project `ex-mio` in Varta's inventory, on that host. Varta reads the container labels
  `varta.project` and `varta.service` and stamps them as `varta_project` and `varta_service`. A
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
- A key is lower-cased, and any character outside `[a-z0-9_]` becomes `_`.
- Nested values, JSON text, PII-named keys and keys over 64 characters are dropped, and the event
  gets `varta_props_dropped = true`.
- Filter with `kind = 'product_event'` and `varta_project = 'ex-mio'`, using `=`, not `LIKE`.
- Count with `count(DISTINCT event_id)` or `count(DISTINCT varta_actor_key)`, never `count(*)`. On
  OpenObserve 0.14, `count(*)` over-counts while data is still arriving.
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

Players and operators are identified by `varta_actor_key`. For steps that have no actor (or to
count events themselves), use `count(DISTINCT event_id)`. The tenant view of the same step:

```sql
SELECT tenant_id, count(DISTINCT event_id) AS events
FROM "product_events"
WHERE kind = 'product_event'
  AND varta_project = 'ex-mio'
  AND event = 'payments.payment_succeeded'
GROUP BY tenant_id
```

Steps, one query each, event names from [analytics.md](../analytics.md):

| Funnel | Steps, in order |
| --- | --- |
| Operator activation | `identity.operator_signed_up`, `identity.credential_issued`, `engagement.deposit_ingested` |
| Operator revenue | `payments.plan_selected`, `payments.payment_succeeded` |
| Player loop | `web.widget_opened`, `identity.player_launched`, `engagement.deposit_ingested`, `engagement.spin_completed`, `payments.coins_credited`, `engagement.redemption_requested`, `engagement.redemption_resolved` |

Money: `SELECT sum(CAST(props_amount_minor AS DOUBLE)) ...` over `payments.payment_succeeded`, with
`props_sandbox = 'false'` (a string, not a boolean).

## Screenshot steps for the demo

Run once the demo has been run against pre-prod with the override. Review every image before it is
published; blur hostnames, tenant ids and anything else internal.

1. Start the stack with the override, run `scripts/demo.sh`, and wait about a minute.
2. Open `<varta-panel>`, log in, go to Logs.
3. Pick stream `product_events`, set the time range to cover the demo run.
4. Switch to SQL mode and run the "Events per funnel step, per tenant" query. Capture the result table.
5. Run the "Operator activation" query. Capture it.
6. Run the "Player loop" query. Capture it.
7. Capture one raw row (expand it) to show the envelope: `event`, `event_v`, `tenant_id`,
   `varta_project`, `varta_service`. Check that no email, token or key shows.
8. Hand the images to the owner; nothing is published before that review.
