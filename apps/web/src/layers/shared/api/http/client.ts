// Typed `fetch` wrapper for the FSD `shared/api/http` segment (ADR-0005 §7, §8).
//
// - Base URL is resolved at RUNTIME by `resolveApiBaseUrl`: the server reads the
//   runtime `API_URL` env; the browser defaults to the SAME ORIGIN
//   (relative paths), so the image bakes no domain. Overridable per-client via
//   `HttpClientConfig.baseUrl` (tests / explicit SSR base).
// - JSON in, typed JSON out.
// - Every failure is normalised to a thrown `HttpError` (see ./errors).
// - Unexpected / non-HTTP failures (network, parse, schema drift) are reported
//   through the app-wide `ErrorReporter` facade before being rethrown. Plain
//   HTTP non-2xx responses are expected control flow (401/404/…), so they are
//   NOT reported.
// - Responses may optionally be validated against a passed schema (any Zod
//   schema from `shared/types` satisfies the structural `ResponseSchema`, so
//   this segment does not take a direct dependency on `zod`).

// `apps/web/lib/error-reporter` lives outside the FSD root (`src/layers`), so it
// is reached by relative path — same convention the route boundaries use
// (`app/error.tsx`). Importing it does not modify it.
import { reportError } from '../../../../../lib/error-reporter';
// Deep import of the runtime resolver (not the `shared/config` barrel): the
// barrel also re-exports the i18n navigation primitives, and pulling those into
// the transport graph is both unnecessary and unresolvable under Vitest.
import { resolveApiBaseUrl } from '../../config/runtime';
import { HttpError } from './errors';

/**
 * Structural subset of a Zod schema. Any `z.ZodType<T>` is assignable, so
 * `shared/types` schemas can be passed without `zod` being a web dependency.
 */
export interface ResponseSchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues?: unknown } };
}

/** Next.js fetch extensions (data-cache revalidation / tagging). */
export interface NextFetchOptions {
  revalidate?: number | false;
  tags?: string[];
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequestOptions<T = unknown> {
  method?: HttpMethod;
  /** JSON-serialisable request body; presence flips the default method to POST. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** When supplied, the JSON response is validated and the parsed value typed `T`. */
  schema?: ResponseSchema<T>;
  /** Pass-through `fetch` cache mode (Next.js data-cache control). */
  cache?: RequestCache;
  /** Pass-through Next.js `fetch` extensions. */
  next?: NextFetchOptions;
}

/** Options for verb helpers that never carry a body. */
export type BodylessOptions<T> = Omit<HttpRequestOptions<T>, 'method' | 'body'>;

export interface HttpClientConfig {
  /** Base URL for relative paths. Defaults to `resolveApiBaseUrl()`. */
  baseUrl?: string;
  /** Injectable `fetch` (defaults to the global). Mainly for tests. */
  fetch?: typeof fetch;
  /** Headers merged into every request (e.g. an Accept-Language default). */
  headers?: Record<string, string>;
}

export interface HttpClient {
  request<T = unknown>(path: string, options?: HttpRequestOptions<T>): Promise<T>;
  get<T = unknown>(path: string, options?: BodylessOptions<T>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: BodylessOptions<T>): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, options?: BodylessOptions<T>): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, options?: BodylessOptions<T>): Promise<T>;
  delete<T = unknown>(path: string, options?: BodylessOptions<T>): Promise<T>;
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Best-effort read of a JSON body; returns `undefined` for empty/invalid bodies. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  return JSON.parse(text) as unknown;
}

/** Map a non-2xx `Response` to an `HttpError`, mirroring the server error body. */
async function toHttpError(response: Response): Promise<HttpError> {
  let body: unknown;
  try {
    body = await readJson(response);
  } catch {
    body = undefined;
  }
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const rawMessage = raw.message ?? raw.error;
  const message =
    typeof rawMessage === 'string'
      ? rawMessage
      : Array.isArray(rawMessage)
        ? rawMessage.filter((m) => typeof m === 'string').join('; ')
        : response.statusText || `Request failed with status ${response.status}`;

  return new HttpError({
    status: response.status,
    code: typeof raw.code === 'string' ? raw.code : 'http_error',
    message,
    issues: raw.issues,
  });
}

/** Create an HTTP client. The exported `http` singleton is `createHttpClient()`. */
export function createHttpClient(config: HttpClientConfig = {}): HttpClient {
  function resolveUrl(path: string): string {
    // Runtime resolution: server -> `API_URL`, browser -> same origin.
    const base = resolveApiBaseUrl(config.baseUrl);
    // The browser can fetch a relative path against the current origin (`base`
    // may legitimately be `''`), but a server-side fetch has no origin to anchor
    // one, so an empty base there is a real misconfiguration.
    if (!base && typeof window === 'undefined') {
      throw new HttpError({
        status: 0,
        code: 'config_error',
        message:
          'No API base URL is set on the server; set API_URL (or NEXT_PUBLIC_API_URL) so SSR can reach the API.',
      });
    }
    return joinUrl(base, path);
  }

  async function request<T>(path: string, options: HttpRequestOptions<T> = {}): Promise<T> {
    const fetchImpl = config.fetch ?? globalThis.fetch;
    const url = resolveUrl(path);
    const hasBody = options.body !== undefined;
    const method = options.method ?? (hasBody ? 'POST' : 'GET');

    const init: RequestInit & { next?: NextFetchOptions } = {
      method,
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...config.headers,
        ...options.headers,
      },
    };
    if (hasBody) init.body = JSON.stringify(options.body);
    if (options.signal) init.signal = options.signal;
    if (options.cache) init.cache = options.cache;
    if (options.next) init.next = options.next;

    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (cause) {
      // `fetch` only rejects on network-level failures (offline, DNS, CORS,
      // abort) — unexpected, so report it, then surface a normalised envelope.
      // Headers are deliberately omitted from the report (may carry auth tokens).
      reportError(cause, { scope: 'http', url, method });
      throw new HttpError({
        status: 0,
        code: 'network_error',
        message: cause instanceof Error ? cause.message : 'Network request failed.',
        cause,
      });
    }

    if (!response.ok) {
      // Expected control flow — surfaced, not reported.
      throw await toHttpError(response);
    }

    if (response.status === 204) return undefined as T;

    let data: unknown;
    try {
      data = await readJson(response);
    } catch (cause) {
      reportError(cause, { scope: 'http', url, reason: 'parse' });
      throw new HttpError({
        status: 0,
        code: 'parse_error',
        message: 'Failed to parse the response body as JSON.',
        cause,
      });
    }

    if (options.schema) {
      const result = options.schema.safeParse(data);
      if (!result.success) {
        // A schema mismatch means the server contract drifted — unexpected.
        reportError(result.error, { scope: 'http', url, reason: 'validation' });
        throw new HttpError({
          status: response.status,
          code: 'validation_error',
          message: 'The response did not match the expected schema.',
          issues: result.error.issues,
          cause: result.error,
        });
      }
      return result.data;
    }

    return data as T;
  }

  return {
    request,
    get<T = unknown>(path: string, options?: BodylessOptions<T>) {
      return request<T>(path, options);
    },
    post<T = unknown>(path: string, body?: unknown, options?: BodylessOptions<T>) {
      return request<T>(path, { ...options, method: 'POST', body });
    },
    put<T = unknown>(path: string, body?: unknown, options?: BodylessOptions<T>) {
      return request<T>(path, { ...options, method: 'PUT', body });
    },
    patch<T = unknown>(path: string, body?: unknown, options?: BodylessOptions<T>) {
      return request<T>(path, { ...options, method: 'PATCH', body });
    },
    delete<T = unknown>(path: string, options?: BodylessOptions<T>) {
      return request<T>(path, { ...options, method: 'DELETE' });
    },
  };
}

/** Default client bound to the runtime-resolved API base and the global `fetch`. */
export const http: HttpClient = createHttpClient();
