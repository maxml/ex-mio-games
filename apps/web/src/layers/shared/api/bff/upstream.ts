// One place that calls the services for the BFF: injects the bearer, validates every answer against the
// shared contract, and turns a failure into a `BffError` the router answers with `{message, code}`.
import type { BffConfig } from './config';

export class BffError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = 'BffError';
  }
}

/** Structural subset of a zod schema (the web does not depend on zod directly). */
export interface Parser<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

export function listOf<T>(item: Parser<T>): Parser<T[]> {
  return {
    safeParse(v) {
      if (!Array.isArray(v)) return { success: false };
      const out: T[] = [];
      for (const x of v) {
        const r = item.safeParse(x);
        if (!r.success) return { success: false };
        out.push(r.data);
      }
      return { success: true, data: out };
    },
  };
}

export type ServiceName = 'identity' | 'payments' | 'engagement';

export interface UpstreamOptions<T> {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  schema?: Parser<T>;
  /** A 404 is a normal answer ("nothing yet"): resolve `null` instead of throwing. */
  nullOn404?: boolean;
}

export type Upstream = <T = unknown>(
  service: ServiceName | 'casino-sim',
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options?: UpstreamOptions<T>,
) => Promise<T>;

/**
 * `fetch`, except that a caller-set `Host` header is honoured. Node's built-in fetch (undici) silently
 * replaces `Host` with the URL's host, and identity resolves the tenant from `Host` alone
 * (`<slug>.<BASE_DOMAIN>`), so a login through the BFF would always be TENANT_UNRESOLVED. Only the calls
 * that set `host` take the `node:http` path; everything else is plain fetch.
 */
export const fetchHonouringHost: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const host = headers.get('host');
  if (!host) return fetch(input, init);
  const { request } = await import('node:http');
  const url = new URL(String(input));
  const body = typeof init?.body === 'string' ? init.body : undefined;
  return new Promise<Response>((resolve, reject) => {
    const outgoing: Record<string, string> = {};
    headers.forEach((v, k) => (outgoing[k] = v));
    if (body !== undefined) outgoing['content-length'] = String(Buffer.byteLength(body));
    const req = request(url, { method: init?.method ?? 'GET', headers: outgoing }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve(
          new Response(chunks.length ? Buffer.concat(chunks) : null, {
            status: res.statusCode ?? 502,
          }),
        ),
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
};

export function createUpstream(
  config: BffConfig,
  fetchImpl: typeof fetch = fetchHonouringHost,
): Upstream {
  const base = (service: ServiceName | 'casino-sim') =>
    service === 'identity'
      ? config.identityUrl
      : service === 'payments'
        ? config.paymentsUrl
        : service === 'engagement'
          ? config.engagementUrl
          : config.casinoSimUrl;

  return async function call<T>(
    service: ServiceName | 'casino-sim',
    method: string,
    path: string,
    options: UpstreamOptions<T> = {},
  ): Promise<T> {
    const root = base(service);
    if (!root)
      throw new BffError(501, 'service_not_configured', `${service} URL is not configured`);
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
      });
    } catch {
      throw new BffError(502, 'upstream_unavailable', `${service} is unreachable`);
    }

    const text = await response.text().catch(() => '');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (response.status === 404 && options.nullOn404) return null as T;
    if (!response.ok) {
      const raw = (typeof json === 'object' && json !== null ? json : {}) as Record<
        string,
        unknown
      >;
      // A 5xx is an unknown outcome for the browser (it may retry the same key); never leak a service's text.
      if (response.status >= 500)
        throw new BffError(502, 'upstream_unavailable', `${service} failed`);
      throw new BffError(
        response.status,
        typeof raw.code === 'string' ? raw.code : 'http_error',
        typeof raw.message === 'string'
          ? raw.message
          : `Request failed with status ${response.status}`,
      );
    }
    if (!options.schema) return json as T;
    const parsed = options.schema.safeParse(json);
    if (!parsed.success)
      throw new BffError(
        502,
        'bad_upstream_response',
        `${service} answered with an unexpected shape`,
      );
    return parsed.data;
  };
}
