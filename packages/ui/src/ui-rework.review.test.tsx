// @vitest-environment jsdom
// Hostile review of the operator UI rework (6488273..a531b7b). Written by the reviewer.
// Review: dev-materials/2026-11-21-ex-mio-games/review-briefs/out/ui-rework-review.md.
//
// UIR-4 (major, vacuous test, green now): A-SB-3's own mutation does not turn SpinPanel/DoubleClick red.
//   The story's stand-in server answers inside onSpin (setSpin at once), so the wheel is already animating
//   and the button disabled before the second click lands: the lock is never what stops it. Re-applied by
//   the reviewer: delete `if (clicked.current) return; clicked.current = true; setLocked(true);` from
//   click() in SpinPanel.tsx -> the story stays green (3 passed). Here the server has not answered yet
//   (spin stays null, busy not set), and both clicks land in one tick. Same mutation -> both cases below go
//   red (onSpin called 2 times).
// UIR-7 (note, layout regression, it.fails): a531b7b put the admin stat tiles in <Grid cols={4}>, whose
//   classes are 'grid-cols-2 lg:grid-cols-4'. The markup it replaced was 'sm:grid-cols-2 lg:grid-cols-4'
//   (one column on a phone). Measured with Playwright at 375 px: 343px (6488273) -> 165.5px 165.5px
//   (a531b7b). Section 6: the admin behaviour does not change, only its markup moves.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Grid } from './Layout';
import { SpinPanel } from './SpinPanel';

const segments = ['10', '25', '50', '100'].map((label, i) => ({ id: `s${i}`, label }));

describe('UIR-4 SpinPanel: a double click reaches the server once while the answer is outstanding', () => {
  it('two clicks in one tick, no answer yet: onSpin once', () => {
    const onSpin = vi.fn();
    render(<SpinPanel segments={segments} spin={null} spinsLeft={3} onSpin={onSpin} />);
    const button = screen.getByRole('button', { name: 'Spin' });
    act(() => {
      button.click();
      button.click();
    });
    expect(onSpin).toHaveBeenCalledTimes(1);
  });

  it('two clicks one after the other, no answer yet: onSpin once and the button is off', () => {
    const onSpin = vi.fn();
    render(<SpinPanel segments={segments} spin={null} spinsLeft={3} onSpin={onSpin} />);
    const button = screen.getByRole('button', { name: 'Spin' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onSpin).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
  });
});

describe('UIR-7 Grid cols={4} keeps one column on a phone (the admin stat tiles before a531b7b)', () => {
  it.fails('the four-column grid starts at one column', () => {
    const { container } = render(
      <Grid cols={4}>
        <span>a</span>
      </Grid>,
    );
    const cls = (container.firstChild as HTMLElement).className.split(/\s+/);
    expect(cls).toContain('grid-cols-1');
    expect(cls).not.toContain('grid-cols-2');
  });
});
