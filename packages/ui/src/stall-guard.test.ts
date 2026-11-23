import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { TestModule, Vitest } from 'vitest/node';
import { StallGuard } from '../vitest.stall-guard';

// The guard is what turns a hung browser run into a red one (vitest.config.ts). These pin that it
// fires after the quiet limit, that progress postpones it, that it names what never finished, and
// that a finished run disarms it.
const LIMIT = 1000;
const vitest = { config: { root: '/repo/packages/ui' } } as unknown as Vitest;
const mod = (file: string, project = 'storybook (chromium)') =>
  ({
    moduleId: `/repo/packages/ui/src/${file}`,
    project: { name: project },
  }) as unknown as TestModule;

describe('StallGuard', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    vi.useFakeTimers();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.useRealTimers();
    stderr.mockRestore();
  });

  it('exits 1 after the limit with no progress and names the files not finished', () => {
    const exit = vi.fn();
    const guard = new StallGuard(LIMIT, exit);
    guard.onInit(vitest);
    guard.onTestModuleQueued(mod('Wheel.stories.tsx'));
    guard.onTestModuleQueued(mod('Coin.stories.tsx'));
    guard.onTestModuleStart(mod('Coin.stories.tsx'));
    guard.onTestModuleEnd(mod('Coin.stories.tsx'));
    vi.advanceTimersByTime(LIMIT - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('STALLED');
    expect(out).toContain('[storybook (chromium), queued] src/Wheel.stories.tsx');
    expect(out).not.toContain('Coin.stories.tsx');
  });

  it('a test result resets the clock', () => {
    const exit = vi.fn();
    const guard = new StallGuard(LIMIT, exit);
    guard.onInit(vitest);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(LIMIT - 100);
      guard.onTestCaseResult();
    }
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIMIT);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('the end of the run disarms it', () => {
    const exit = vi.fn();
    const guard = new StallGuard(LIMIT, exit);
    guard.onInit(vitest);
    guard.onTestRunEnd();
    vi.advanceTimersByTime(LIMIT * 10);
    expect(exit).not.toHaveBeenCalled();
  });
});
