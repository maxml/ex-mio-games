// Public API for the `shared/api/http` segment — the typed `fetch` wrapper plus
// the unified error envelope (ADR-0005 §7, §8).
export {
  createHttpClient,
  http,
  type HttpClient,
  type HttpClientConfig,
  type HttpRequestOptions,
  type BodylessOptions,
  type HttpMethod,
  type NextFetchOptions,
  type ResponseSchema,
} from './client';
export { HttpError, isHttpError, type HttpErrorCode, type HttpErrorInit } from './errors';
