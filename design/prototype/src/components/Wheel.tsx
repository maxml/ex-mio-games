import { useEffect, useRef, useState } from 'react';
import { cn } from './cn';

export interface WheelSegment {
  id: string;
  label: string;
}

export interface WheelSpin {
  /** Index of the segment the SERVER picked. The wheel only animates to it; it never chooses. */
  index: number;
  /** Server spin id. A new id animates; an id the wheel has already seen (or mounted with) never does. */
  id: string;
}

export interface WheelProps {
  segments: WheelSegment[];
  spin: WheelSpin | null;
  /** Animation finished. Cosmetic only: the prize was credited when the result arrived. */
  onSpinEnd?: (spinId: string) => void;
  /** Pixel size of the square wheel; it also shrinks to the container width. */
  size?: number;
  durationMs?: number;
  className?: string;
}

const TURNS = 5;

function polar(angleDeg: number, r: number): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180; // 0deg = top, clockwise
  return [r * Math.cos(a), r * Math.sin(a)];
}

function slicePath(start: number, end: number, r: number): string {
  const [x1, y1] = polar(start, r);
  const [x2, y2] = polar(end, r);
  const large = end - start > 180 ? 1 : 0;
  return `M0 0 L${x1.toFixed(3)} ${y1.toFixed(3)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`;
}

/** Resting angle for a result: the chosen segment under the pointer, with a small stable offset. */
function restAngle(spin: WheelSpin, n: number): number {
  const step = 360 / n;
  let h = 0;
  for (const c of spin.id) h = (h * 31 + c.charCodeAt(0)) % 233280;
  const jitter = (h / 233280 - 0.5) * step * 0.6;
  return (360 - ((spin.index + 0.5) * step + jitter)) % 360;
}

export function Wheel({
  segments,
  spin,
  onSpinEnd,
  size = 320,
  durationMs = 4200,
  className,
}: WheelProps) {
  const n = segments.length;
  const step = 360 / n;
  // A wheel that mounts with a result already in hand (tab switch, remount) shows it at rest.
  // It must not animate it again and must not report it as new: `handled` starts at that id.
  const handled = useRef<string | null>(spin?.id ?? null);
  const [rotation, setRotation] = useState(() => (spin ? TURNS * 360 + restAngle(spin, n) : 0));
  const [animating, setAnimating] = useState(false);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (!spin || spin.id === handled.current) return;
    handled.current = spin.id;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const target = restAngle(spin, n);
    setRotation((current) => {
      const base = current - (((current % 360) + 360) % 360);
      return base + TURNS * 360 + target;
    });
    pending.current = spin.id;
    setAnimating(true);
    const t = window.setTimeout(finish, reduce ? 50 : durationMs + 100); // fallback if transitionend is missed
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spin?.id]);

  function finish() {
    if (pending.current === null) return;
    const id = pending.current;
    pending.current = null;
    setAnimating(false);
    onSpinEnd?.(id);
  }

  return (
    <div
      className={cn('relative mx-auto aspect-square w-full', className)}
      style={{ maxWidth: size }}
      role="img"
      aria-label={`Wheel of Fortune with ${n} segments: ${segments.map((s) => s.label).join(', ')}`}
    >
      {/* Pointer */}
      <svg
        viewBox="-10 0 20 16"
        className="absolute left-1/2 top-0 z-10 w-[8%] -translate-x-1/2 -translate-y-1/4"
        aria-hidden
      >
        <path
          d="M-9 0 H9 L0 16 Z"
          style={{ fill: 'var(--wheel-rim)', stroke: 'var(--surface)', strokeWidth: 1.5 }}
        />
      </svg>
      <svg
        viewBox="-104 -104 208 208"
        className="h-full w-full"
        style={{
          transform: `rotate(${rotation}deg)`,
          transition: animating
            ? `transform ${durationMs}ms cubic-bezier(0.12, 0.7, 0.12, 1)`
            : 'none',
        }}
        onTransitionEnd={finish}
        aria-hidden
      >
        <circle r="103" style={{ fill: 'var(--wheel-rim)' }} />
        {segments.map((s, i) => {
          const start = i * step;
          const mid = start + step / 2;
          return (
            <g key={s.id}>
              <path
                d={slicePath(start, start + step, 98)}
                style={{
                  fill: `var(--wheel-${(i % 6) + 1})`,
                  stroke: 'var(--wheel-rim)',
                  strokeWidth: 1,
                }}
              />
              {/* The label sits on its segment but is turned back by the segment angle plus the wheel's
                  current rotation, so on screen it is upright at rest, mid-spin and after any spin. */}
              <g transform={`rotate(${mid}) translate(0 -62)`}>
                <g
                  data-label-turn={s.id}
                  style={{
                    transform: `rotate(${-(mid + rotation)}deg)`,
                    transition: animating
                      ? `transform ${durationMs}ms cubic-bezier(0.12, 0.7, 0.12, 1)`
                      : 'none',
                  }}
                >
                  <text
                    textAnchor="middle"
                    dominantBaseline="middle"
                    style={{
                      fill: 'var(--wheel-fg)',
                      fontSize: n > 8 ? 9 : 11,
                      fontWeight: 700,
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {s.label}
                  </text>
                </g>
              </g>
            </g>
          );
        })}
        <circle r="16" style={{ fill: 'var(--wheel-rim)' }} />
        <circle r="10" style={{ fill: 'var(--surface)' }} />
      </svg>
    </div>
  );
}
