// @vitest-environment jsdom
// Re-review of the UI rework fix round (bf0f3cc..961aedf). Written by the re-reviewer.
// Review: dev-materials/2026-11-21-ex-mio-games/review-briefs/out/ui-rework-rereview.md.
//
// UIRR-1 (major, regression moved in by UIR-6 / ad0f099, it.fails): the web widget now renders SpinPanel,
//   which turns the Spin button off with the native `disabled` attribute while a spin is locked, busy or
//   animating, and at 0 spins. Before ad0f099 the web widget used `aria-disabled` only, which is what Button
//   itself documents ("A busy button stays focusable (aria-disabled, not `disabled`) so keyboard focus is
//   not thrown to <body>"). Measured in Chromium (mock build, /en/embed/widget): focus on Spin, press Enter
//   -> 80 ms later document.activeElement is <body>; the next Tab lands on the deposit button. At 0 spins the
//   "No spins left" button is not in the Tab order at all, so a keyboard user never reaches the reason.
//   The choke point is SpinPanel (the one place that computes the off state for both the web widget and
//   the prototype). Mutation that this file names: SpinPanel.tsx `disabled={disabled}` (ad0f099) instead
//   of keeping the button focusable with `aria-disabled`.
//   Goes green when SpinPanel keeps the button focusable (no native `disabled`) and marks it
//   aria-disabled="true", with the click still ignored. NOTE for the fix: the earlier reviewer test
//   ui-rework.review.test.tsx UIR-4 asserts `toBeDisabled()` on the locked button; that assertion pins the
//   native attribute and has to become `toHaveAttribute('aria-disabled', 'true')` in the same change. Its
//   onSpin-once assertions stay as they are.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpinPanel } from './SpinPanel';

const segments = ['10', '25', '50', '100'].map((label, i) => ({ id: `s${i}`, label }));

/** Focusable and marked off for assistive tech, the way Button keeps a busy button. */
function expectOffButFocusable(button: HTMLElement) {
  expect(button).not.toHaveAttribute('disabled');
  expect(button).toHaveAttribute('aria-disabled', 'true');
  button.focus();
  expect(document.activeElement).toBe(button);
}

describe('UIRR-1 SpinPanel keeps the Spin button focusable while it is off', () => {
  it.fails('after the first click, before the answer: focus can stay on the button', () => {
    const onSpin = vi.fn();
    render(<SpinPanel segments={segments} spin={null} spinsLeft={3} onSpin={onSpin} />);
    const button = screen.getByRole('button', { name: 'Spin' });
    button.focus();
    act(() => button.click());
    expect(onSpin).toHaveBeenCalledTimes(1);
    expectOffButFocusable(button);
    fireEvent.click(button);
    expect(onSpin).toHaveBeenCalledTimes(1);
  });

  it.fails('while the request is busy', () => {
    render(<SpinPanel segments={segments} spin={null} spinsLeft={3} busy onSpin={vi.fn()} />);
    expectOffButFocusable(screen.getByRole('button', { name: 'Spin' }));
  });

  it.fails('at 0 spins the "No spins left" button stays in the Tab order', () => {
    const onSpin = vi.fn();
    render(<SpinPanel segments={segments} spin={null} spinsLeft={0} onSpin={onSpin} />);
    const button = screen.getByRole('button', { name: 'No spins left' });
    expectOffButFocusable(button);
    fireEvent.click(button);
    expect(onSpin).not.toHaveBeenCalled();
  });
});
