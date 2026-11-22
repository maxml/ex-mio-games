// Product analytics of the web BFF (D-19). The BFF is the one place that sees a widget open before the
// player has launched, so `widget_opened` is written here. The line is built and validated by the same
// `buildProductEvent` as every service's (packages/contracts), and written to stdout as one JSON line,
// where the log collector picks it up. No pino here: the Next server bundle stays small.
import { buildProductEvent, type ProductEventInput } from '../../types';

export type ProductEventSink = (line: Record<string, unknown>) => void;

/** One JSON line on stdout, the way every service writes its product events. */
export const stdoutProductEvents: ProductEventSink = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/**
 * Validate and write one event. Like the services' `emitProductEvent`, a bad event is dropped with
 * a warn line and never fails the request.
 */
export function emitWebEvent(
  sink: ProductEventSink,
  input: ProductEventInput,
  env: Record<string, string | undefined> = process.env,
): void {
  const base = {
    ts: new Date().toISOString(),
    service: 'web',
    env: env.NODE_ENV ?? 'development',
    version: env.APP_VERSION ?? '0.0.1',
  };
  try {
    const payload = buildProductEvent(input);
    // A closed envelope: no `msg`, `pid`, `hostname` or `time` (Varta's collector drops them).
    sink({ ...base, level: 'info', ...payload });
  } catch (err) {
    sink({
      ...base,
      level: 'warn',
      msg: 'product_event_dropped',
      event: input.event,
      err: String(err).slice(0, 300),
    });
  }
}
