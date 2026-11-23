import type { Reporter, TestModule, Vitest } from 'vitest/node';

// Turns a stalled run into a failure with a message. vitest 4.1 browser mode has no timeout for a
// story iframe that never boots (its module fetches aborted, the browser gone): the run waited
// forever after `RUN v4.1.5`. Any test result, module queued, start or end resets the clock; when
// nothing happens for `limitMs` the guard names the files still in flight and exits non-zero.
// Exiting runs Playwright's exit hook, which kills the browser it launched.
export class StallGuard implements Reporter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly inFlight = new Map<string, string>();
  private root = '';

  constructor(
    private readonly limitMs: number,
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {}

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
    this.arm();
  }

  onTestModuleQueued(testModule: TestModule): void {
    this.inFlight.set(testModule.moduleId, `${testModule.project.name}, queued`);
    this.arm();
  }

  onTestModuleStart(testModule: TestModule): void {
    this.inFlight.set(testModule.moduleId, `${testModule.project.name}, started`);
    this.arm();
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.inFlight.delete(testModule.moduleId);
    this.arm();
  }

  onTestCaseResult(): void {
    this.arm();
  }

  onTestRunEnd(): void {
    this.disarm();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => this.fire(), this.limitMs);
    // Never the reason the process stays alive.
    this.timer.unref();
  }

  private fire(): void {
    const files = [...this.inFlight].map(
      ([id, project]) => `  [${project}] ${id.replace(`${this.root}/`, '')}`,
    );
    process.stderr.write(
      [
        '',
        `STALLED: no test progress for ${Math.round(this.limitMs / 1000)} s; failing instead of hanging.`,
        files.length
          ? `Test files not finished:\n${files.join('\n')}`
          : 'No test file was queued yet.',
        'A browser test file that never reports usually means its iframe failed to load (look for',
        'net::ERR_NETWORK_CHANGED or a failed module fetch) or the browser did not start or died.',
        '',
      ].join('\n'),
    );
    this.exit(1);
  }
}
