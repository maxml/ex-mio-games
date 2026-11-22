# Deploy and analytics screens (pre-prod, 2026-11-22)

MIO deployed to a pre-production server with Deckhand, and its product events and logs read in Varta.
The images are rendered from live data read on 2026-11-22 around 20:00 UTC (Varta query results and the
Deckhand deployment record), not captured from a browser UI. Hosts, IPs, tokens, image digests and paths
are left out.

| Image                                      | What it shows                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [deckhand-deploy.png](deckhand-deploy.png) | Deckhand's deployment of release `f74f2d7`: blue/green colour, a backup taken before migrations, 7 images pinned by digest, every service up and healthy.                              |
| [varta-stream.png](varta-stream.png)       | Varta's `product_events` stream for the ex-mio project during a demo run: each event with its service, actor type and consent, cleaned at the collector and attributed to its service. |
| [varta-counts.png](varta-counts.png)       | Product analytics on the same stream: events and distinct actors per event, counted duplicate-proof with `count(DISTINCT …)`.                                                          |

The full demo passes on the pre-production deployment of release `8533c10`: 40 steps, 194 assertions, 0
failures, including reward issuance, the async settle, the casino-timeout recovery and the rejected
issuance. Varta received 57 product events of 10 kinds, all attributed.
