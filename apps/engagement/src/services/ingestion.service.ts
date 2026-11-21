import { createHmac } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  createEvent,
  INGEST_HTTP_STATUS,
  type IngestAck,
  type IngestErrorCode,
} from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { runWithTenant } from '@ex-mio/tenancy';
import type {
  AdapterRegistry,
  CasinoAdapter,
  Headers,
  SignatureVerdict,
} from '../integrations/adapter';
import {
  ADAPTER_REGISTRY,
  CLOCK,
  InboundEventsRepository,
  PLAYER_DIRECTORY,
  TENANT_INTEGRATIONS,
  type Clock,
  type PlayerDirectoryPort,
  type TenantIntegration,
  type TenantIntegrationPort,
} from '../integrations/ports';

const reject = (code: IngestErrorCode, message: string): HttpException =>
  new HttpException({ message, code }, INGEST_HTTP_STATUS[code]);

/** Parsing and verifying never touch the network, so the adapter needs no real transport. */
const noTransport = async (): Promise<never> => {
  throw new Error('the ingestion path makes no outbound call');
};

/**
 * The deposit webhook (docs/specs/engagement-ingest.md section 5). Order of checks, which is the
 * contract: slug lookup, signature (with each active secret), tenant suspended, parse, ignored, then
 * ONE tenant transaction that inserts the inbound row and, only if it was new, writes the outbox
 * message. The signature precedes parsing and the suspended check, so a stranger learns nothing about
 * schemas or tenant state. Logs carry the reason code and the slug, never the body or a secret.
 *
 * D-12 / X-1: the casino's player id is resolved to the internal `player_id` through identity BEFORE
 * the transaction opens, so the outbox row (durable, unreachable by erasure) never holds the raw id.
 * Identity down is 503 with nothing written: the casino retries and there is no dedupe hole.
 * X-3 / D-13: the envelope `sandbox` flag comes from the credential's `environment`, never the request.
 */
@Injectable()
export class IngestionService {
  private readonly log = new Logger(IngestionService.name);

  constructor(
    private readonly db: Db,
    private readonly inbound: InboundEventsRepository,
    @Inject(TENANT_INTEGRATIONS) private readonly integrations: TenantIntegrationPort,
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PLAYER_DIRECTORY) private readonly players: PlayerDirectoryPort,
  ) {}

  async ingest(slug: string, raw: string, headers: Headers): Promise<IngestAck> {
    const integration = await this.integrations.lookup(slug);
    const entry = integration ? this.registry.get(integration.platform) : undefined;
    if (!integration || !entry) {
      this.refuse(slug, 'unknown_tenant');
      throw reject('unknown_tenant', 'unknown tenant');
    }
    const adapter = entry.create({ baseUrl: '', transport: noTransport });

    const verdict = this.verify(adapter, integration, raw, headers);
    if (verdict !== 'valid') {
      const code: IngestErrorCode =
        verdict === 'stale'
          ? 'stale'
          : verdict === 'missing'
            ? 'signature_missing'
            : 'signature_invalid';
      this.refuse(slug, code);
      throw reject(code, 'signature check failed');
    }
    if (integration.status === 'suspended') {
      this.refuse(slug, 'tenant_suspended');
      throw reject('tenant_suspended', 'tenant is suspended');
    }

    const parsed = adapter.parseEvent(raw, headers);
    if (parsed.kind === 'rejected') {
      const code: IngestErrorCode = parsed.reason;
      this.refuse(slug, code);
      throw reject(code, parsed.reason === 'malformed_json' ? 'malformed JSON' : 'invalid event');
    }
    if (parsed.kind === 'ignored') return { status: 'ignored', inbound_event_id: null };

    const e = parsed.event;
    const tenantId = integration.tenant_id;
    // D-12: the row keeps a tenant-keyed HMAC of the casino's player id, never the raw id.
    const externalPlayerHmac = createHmac('sha256', integration.player_hash_key)
      .update(`${e.source}\n${e.external_player_id}`)
      .digest('hex');
    const sandbox = integration.environment === 'sandbox';

    let playerId: string;
    try {
      playerId = await this.players.resolveOrCreate(tenantId, e.source, e.external_player_id);
    } catch {
      // Not logged with the player id: the log line carries the slug only.
      this.log.warn(`ingest refused: identity unavailable (tenant slug ${slug})`);
      throw new HttpException(
        { message: 'identity unavailable, retry', code: 'identity_unavailable' },
        503,
      );
    }

    // The route is public, so there is no ambient tenant yet: the verified tenant opens one.
    return runWithTenant({ tenantId }, () =>
      this.db.tenantTx(async (tx) => {
        const { inserted, id } = await this.inbound.insertIfAbsent(tx, {
          tenantId,
          source: e.source,
          externalEventId: e.external_event_id,
          externalPlayerHmac,
          amountMinor: e.amount_minor,
          currency: e.currency,
          occurredAt: e.occurred_at,
        });
        if (inserted) {
          await this.db.publish(
            tx,
            createEvent({
              type: 'engagement.deposit.confirmed',
              tenantId,
              ...(sandbox ? { sandbox: true } : {}),
              payload: {
                inbound_event_id: id,
                source: e.source,
                external_event_id: e.external_event_id,
                player_id: playerId,
                amount_minor: e.amount_minor,
                currency: e.currency,
                occurred_at: e.occurred_at,
              },
            }),
          );
        }
        return { status: 'accepted' as const, inbound_event_id: id };
      }),
    );
  }

  /** Any of the (at most two) active secrets may verify: a stale or missing verdict ranks over invalid. */
  private verify(
    adapter: CasinoAdapter,
    integration: TenantIntegration,
    raw: string,
    headers: Headers,
  ): SignatureVerdict {
    const now = this.clock.now();
    let best: SignatureVerdict = 'invalid';
    for (const secret of integration.webhook_secrets) {
      // F6: an empty secret is no key (anyone can sign with it); an empty list verifies nothing.
      if (secret === '') continue;
      // F6: an empty secret is no key (anyone can sign with it); an empty list verifies nothing.
      const verdict = adapter.verifySignature(raw, headers, secret, now);
      if (verdict === 'valid') return 'valid';
      if (verdict === 'stale') best = 'stale';
      else if (verdict === 'missing' && best === 'invalid') best = 'missing';
    }
    return best;
  }

  private refuse(slug: string, code: IngestErrorCode): void {
    this.log.warn(`ingest refused: ${code} (tenant slug ${slug})`);
  }
}
