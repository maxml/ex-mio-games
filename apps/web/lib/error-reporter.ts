export interface ErrorReporter {
  report(err: unknown, context?: Record<string, unknown>): void;
}

class ConsoleReporter implements ErrorReporter {
  report(err: unknown, context?: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.error('[error-reporter]', err, context ?? {});
  }
}

// Console is the default so errors are never silently dropped. Swap in a real
// backend (an error-tracking SDK, a log shipper) with setErrorReporter; the rest
// of the app only ever calls reportError, never a concrete reporter.
let reporter: ErrorReporter = new ConsoleReporter();

export function setErrorReporter(next: ErrorReporter): void {
  reporter = next;
}

export function reportError(err: unknown, context?: Record<string, unknown>): void {
  reporter.report(err, context);
}
