import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { ServerResponse } from 'node:http';
import type { AppMetrics } from './metrics';

// Minimal structural shapes of the Fastify request/reply, so this file does not
// depend on `fastify`'s types directly (it is only a transitive dependency).
interface RoutedRequest {
  method?: string;
  routeOptions?: { url?: string };
}
interface FastifyReplyLike {
  raw: ServerResponse;
}

/**
 * Records the §2.1 HTTP server metrics (`http_server_requests_total` +
 * `http_server_request_duration_seconds`) per request, labeled with the ROUTE
 * TEMPLATE (e.g. `/api/files/:key`) — never the raw path — to keep metric
 * cardinality low (§8). Wired globally; a pure passthrough when metrics are
 * disabled (no OTLP endpoint), so the app behaves exactly as today.
 */
@Injectable()
export class MetricsHttpInterceptor implements NestInterceptor {
  constructor(private readonly metrics: AppMetrics) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !this.metrics.enabled) {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<RoutedRequest>();
    const reply = http.getResponse<FastifyReplyLike>();
    const method = request.method ?? 'UNKNOWN';
    // Fastify exposes the matched route template on routeOptions.url; the
    // interceptor only runs for matched controller handlers, so it is set.
    const route = request.routeOptions?.url ?? 'unmatched';
    const startNs = process.hrtime.bigint();

    // Record once the response is fully flushed, so status_code is the real wire
    // status — this covers plain returns, @HttpCode, and exception-filter
    // responses alike, without depending on interceptor/serialization ordering.
    reply.raw.once('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      const labels = { method, route, status_code: String(reply.raw.statusCode) };
      this.metrics.requestsTotal.add(1, labels);
      this.metrics.requestDuration.record(durationSeconds, labels);
    });

    return next.handle();
  }
}
