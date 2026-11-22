# Deploy and analytics screens (pre-prod, 2026-11-22)

MIO deployed to a pre-production server with Deckhand, and its product events and logs read in Varta.
The images are rendered from live data read on 2026-11-22 around 20:00 UTC (Varta query results and the
Deckhand deployment record), not captured from a browser UI. Hosts, IPs, tokens, image digests and paths
are left out.

| Image | What it shows |
| --- | --- |
| [deckhand-deploy.png](deckhand-deploy.png) | Deckhand's deployment of release `f74f2d7`: blue/green colour, a backup taken before migrations, 7 images pinned by digest, every service up and healthy. |
| [varta-stream.png](varta-stream.png) | Varta's `product_events` stream for the ex-mio project during a demo run: each event with its service, actor type and consent, cleaned at the collector and attributed to its service. |
| [varta-counts.png](varta-counts.png) | Product analytics on the same stream: events and distinct actors per event, counted duplicate-proof with `count(DISTINCT …)`. |

The demo run on pre-prod passed steps 1 to 28 (operator signup, plan payment, credentials, deposits,
launch, spin, redeem request). The reward issuance step needs one config change for the deployed
engagement service; it is tracked in the repository's known gaps.
