import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { Wheel, type WheelSegment, type WheelSpin } from './Wheel';

export interface SpinPanelProps {
  segments: WheelSegment[];
  /** The server's result. A new id animates the wheel; the panel never picks a prize. */
  spin: WheelSpin | null;
  /** Text announced once the wheel stops, for example "You won 100 coins". */
  result?: string;
  spinsLeft: number;
  /** A spin request is in flight. */
  busy?: boolean;
  onSpin: () => void;
  onSpinEnd?: (spinId: string) => void;
  durationMs?: number;
  size?: number;
}

/**
 * The wheel, the Spin button, the spins left and an `aria-live` result. The button is disabled from
 * the first click until `spin` changes (and the animation ends) or `busy` clears, so a double click
 * calls `onSpin` once.
 */
export function SpinPanel({
  segments,
  spin,
  result,
  spinsLeft,
  busy,
  onSpin,
  onSpinEnd,
  durationMs,
  size,
}: SpinPanelProps) {
  // `clicked` is a ref as well as state: two clicks in one tick must still call onSpin once.
  const clicked = useRef(false);
  const [locked, setLocked] = useState(false);
  const mounted = useRef(spin?.id ?? null);
  const [animating, setAnimating] = useState(false);
  const [ended, setEnded] = useState<string | null>(spin?.id ?? null);
  const wasBusy = useRef(false);

  useEffect(() => {
    if (spin && spin.id !== mounted.current) {
      mounted.current = spin.id;
      clicked.current = false;
      setLocked(false);
      setAnimating(true);
    }
  }, [spin?.id]);

  useEffect(() => {
    // The request ended without a new result (a failure): allow another try.
    if (wasBusy.current && !busy && !animating) {
      clicked.current = false;
      setLocked(false);
    }
    wasBusy.current = Boolean(busy);
  }, [busy, animating]);

  function click() {
    if (clicked.current) return;
    clicked.current = true;
    setLocked(true);
    onSpin();
  }

  function end(id: string) {
    setAnimating(false);
    setEnded(id);
    onSpinEnd?.(id);
  }

  const disabled = locked || animating || Boolean(busy) || spinsLeft < 1;
  return (
    <div className="grid gap-3">
      <Wheel segments={segments} spin={spin} onSpinEnd={end} durationMs={durationMs} size={size} />
      <p className="text-center text-sm text-fg-muted">
        Spins left: <span className="font-semibold tabular-nums text-fg">{spinsLeft}</span>
      </p>
      <Button size="lg" disabled={disabled} loading={busy} onClick={click}>
        Spin
      </Button>
      <p role="status" aria-live="polite" className="min-h-5 text-center text-sm font-semibold">
        {spin && ended === spin.id ? result : ''}
      </p>
    </div>
  );
}
