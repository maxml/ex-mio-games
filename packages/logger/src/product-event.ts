import { ProductEventLine } from '@ex-mio/contracts';
import type { AppLogger } from './logger';

export type ProductEventInput = Omit<ProductEventLine, 'kind'>;

/**
 * Emit a product analytics event as one JSON line (`kind: "product_event"`) on
 * the service's stdout, next to ordinary log lines. The line is validated
 * first: an event without a tenant or with a malformed name throws instead of
 * silently polluting the analytics stream.
 *
 * Call this from the service layer at the moment the business fact happens
 * (deposit credited, spin completed), not from a controller.
 */
export function logProductEvent(logger: AppLogger, event: ProductEventInput): void {
  const line = ProductEventLine.parse({ kind: 'product_event', ...event });
  logger.info(line, line.event);
}
