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

## Funnel queries

Varta does not ship saved queries for MIO yet. Save these in the panel (Logs, stream
`product_events`, SQL mode). Event names are in [analytics.md](../analytics.md). Check the column
names of the props (`sandbox`, `plan_code`, ...) against the live stream before relying on them.

Events per funnel step, per tenant:

```sql
SELECT event, tenant_id, count(*) AS n
FROM "product_events"
WHERE kind = 'product_event' AND varta_project = 'ex-mio'
GROUP BY event, tenant_id
ORDER BY event, tenant_id
```

Operator activation (distinct tenants per step):

```sql
SELECT event, count(DISTINCT tenant_id) AS tenants
FROM "product_events"
WHERE kind = 'product_event' AND varta_project = 'ex-mio'
  AND event IN ('identity.operator_signed_up', 'payments.plan_selected',
                'payments.payment_succeeded', 'identity.credential_issued',
                'engagement.deposit_ingested')
GROUP BY event
```

Player loop (events per step):

```sql
SELECT event, count(*) AS n
FROM "product_events"
WHERE kind = 'product_event' AND varta_project = 'ex-mio'
  AND event IN ('web.widget_opened', 'identity.player_launched', 'engagement.deposit_ingested',
                'engagement.spin_completed', 'payments.coins_credited',
                'engagement.redemption_requested', 'engagement.redemption_resolved')
GROUP BY event
```

Events can be read twice after a collector crash. Each carries `event_id`, so for exact counts use
`count(DISTINCT event_id)` instead of `count(*)`.

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
