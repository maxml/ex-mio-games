import { LogLine, ProductEventLine } from '@ex-mio/contracts';
import { createLogger } from './logger';
import { logProductEvent } from './product-event';

const TENANT = '0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

function capture() {
  const chunks: string[] = [];
  const logger = createLogger(
    { name: 'test-svc', level: 'info' },
    { write: (s) => void chunks.push(s) },
  );
  return { logger, lines: () => chunks.map((c) => JSON.parse(c) as Record<string, unknown>) };
}

describe('logProductEvent', () => {
  it('writes a product_event line that is also a valid log line', () => {
    const { logger, lines } = capture();
    logProductEvent(logger, {
      event: 'spin_completed',
      tenant_id: TENANT,
      properties: { coins: 5 },
    });
    const [line] = lines();
    expect(ProductEventLine.parse(line)).toMatchObject({
      kind: 'product_event',
      event: 'spin_completed',
    });
    expect(LogLine.safeParse(line).success).toBe(true);
  });

  it('refuses an event without a tenant', () => {
    const { logger, lines } = capture();
    expect(() =>
      logProductEvent(logger, { event: 'spin_completed' } as unknown as Parameters<
        typeof logProductEvent
      >[1]),
    ).toThrow();
    expect(lines()).toHaveLength(0);
  });

  it('refuses a malformed event name', () => {
    const { logger } = capture();
    expect(() => logProductEvent(logger, { event: 'Spin Completed', tenant_id: TENANT })).toThrow();
  });
});
