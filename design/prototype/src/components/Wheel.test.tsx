// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wheel } from './Wheel';

const segments = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, label: String(n) }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Wheel only animates results that arrive while it is mounted', () => {
  it('mounted with a result already in hand: no animation, no onSpinEnd (the old re-credit bug)', () => {
    const onSpinEnd = vi.fn();
    const { container } = render(<Wheel segments={segments} spin={{ id: 'spin-1', index: 2 }} onSpinEnd={onSpinEnd} />);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onSpinEnd).not.toHaveBeenCalled();
    expect(container.querySelector('svg[viewBox="-104 -104 208 208"]')!.getAttribute('style') ?? '').not.toMatch(/transition: transform/);
  });

  it('a new spin id animates and reports the end once', () => {
    const onSpinEnd = vi.fn();
    const { rerender } = render(<Wheel segments={segments} spin={null} onSpinEnd={onSpinEnd} />);
    rerender(<Wheel segments={segments} spin={{ id: 'spin-1', index: 1 }} onSpinEnd={onSpinEnd} />);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onSpinEnd).toHaveBeenCalledTimes(1);
    expect(onSpinEnd).toHaveBeenCalledWith('spin-1');
    // Same id again (parent re-render): nothing more.
    rerender(<Wheel segments={segments} spin={{ id: 'spin-1', index: 1 }} onSpinEnd={onSpinEnd} />);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onSpinEnd).toHaveBeenCalledTimes(1);
  });

  it('unmount and remount with the same result does not report it again', () => {
    const onSpinEnd = vi.fn();
    const spin = { id: 'spin-1', index: 1 };
    const a = render(<Wheel segments={segments} spin={null} onSpinEnd={onSpinEnd} />);
    a.rerender(<Wheel segments={segments} spin={spin} onSpinEnd={onSpinEnd} />);
    act(() => void vi.advanceTimersByTime(10_000));
    a.unmount();
    render(<Wheel segments={segments} spin={spin} onSpinEnd={onSpinEnd} />);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(onSpinEnd).toHaveBeenCalledTimes(1);
  });
});
