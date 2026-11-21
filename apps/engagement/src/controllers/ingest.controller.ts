import { Body, Controller, Headers, HttpCode, HttpException, Param, Post } from '@nestjs/common';
import { IngestAck, INGEST_HTTP_STATUS } from '@ex-mio/contracts';
import { Public } from '@ex-mio/tenancy';
import { IngestionService } from '../services/ingestion.service';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const INGEST_PREFIX = '/v1/integrations/';

/**
 * F7: the replacement parser must keep Fastify's own prototype-poisoning guard (`onProtoPoisoning`
 * and `onConstructorPoisoning` are `error` by default; a bare `JSON.parse` drops them). The reviver
 * sees every key of every object, so an own `__proto__` key (also one written as an escape,
 * `"__proto__"`) and a `constructor` carrying `prototype` are refused wherever they sit.
 */
export function parseWithoutPoisoning(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => {
    if (key === '__proto__') throw new Error('prototype poisoning: __proto__ key');
    if (
      key === 'constructor' &&
      typeof value === 'object' &&
      value !== null &&
      Object.hasOwn(value, 'prototype')
    )
      throw new Error('prototype poisoning: constructor.prototype');
    return value;
  });
}

/**
 * The casino webhook route reads the RAW body string (the signature covers its exact bytes), so the
 * service verifies first and `JSON.parse`s after. Every other route keeps the ordinary parsed JSON
 * body: this swaps Fastify's JSON parser for one that leaves the ingest route's body a string.
 */
export function registerRawJsonParser(instance: ParserHost): void {
  // Nest registers its own JSON parser while the application initialises, and Fastify refuses a
  // second one, so the swap happens when the server is ready: after Nest's, before any request.
  instance.addHook('onReady', async () => {
    instance.removeContentTypeParser('application/json');
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      if (req.url.startsWith(INGEST_PREFIX)) {
        done(null, body);
        return;
      }
      try {
        done(null, body === '' ? {} : parseWithoutPoisoning(body as string));
      } catch {
        done(Object.assign(new Error('malformed JSON body'), { statusCode: 400 }), undefined);
      }
    });
  });
}

/** The Fastify instance methods this needs (the `fastify` package is not a direct dependency). */
interface ParserHost {
  addHook(name: 'onReady', hook: () => Promise<void>): unknown;
  removeContentTypeParser(contentType: string): void;
  addContentTypeParser(
    contentType: string,
    opts: { parseAs: 'string' },
    parser: (
      req: { url: string },
      body: string | Buffer,
      done: (err: Error | null, body?: unknown) => void,
    ) => void,
  ): void;
}

/** `POST /v1/integrations/{tenantSlug}/events`: public (the casino signs it), tenant from the slug only. */
@Controller('v1/integrations')
export class IngestController {
  constructor(private readonly ingestion: IngestionService) {}

  @Public()
  @Post(':slug/events')
  @HttpCode(200)
  async receive(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<IngestAck> {
    if (!SLUG_RE.test(slug)) {
      throw new HttpException(
        { message: 'unknown tenant', code: 'unknown_tenant' },
        INGEST_HTTP_STATUS.unknown_tenant,
      );
    }
    const raw = typeof body === 'string' ? body : '';
    return IngestAck.parse(await this.ingestion.ingest(slug, raw, headers));
  }
}
