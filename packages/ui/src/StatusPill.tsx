import type { ReactNode } from 'react';
import { cn } from './cn';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

const TONES: Record<Tone, string> = {
  neutral: 'text-fg-muted border-border',
  success: 'text-success border-success',
  warning: 'text-warning border-warning',
  danger: 'text-danger border-danger',
  info: 'text-info border-info',
  primary: 'text-primary border-primary',
};
// Icons so status never relies on colour alone.
const ICONS: Record<Tone, string> = {
  neutral: '•',
  success: '✓',
  warning: '◷',
  danger: '✕',
  info: 'i',
  primary: '★',
};

export interface BadgeProps {
  tone?: Tone;
  icon?: boolean;
  children: ReactNode;
  className?: string;
}

/** Small outlined label. Use StatusPill for domain statuses. */
export function Badge({ tone = 'neutral', icon = false, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border bg-surface px-2 py-0.5 text-xs font-semibold',
        TONES[tone],
        className,
      )}
    >
      {icon && <span aria-hidden>{ICONS[tone]}</span>}
      {children}
    </span>
  );
}

/** Every status the product shows, mapped once so all screens agree on wording and tone. */
export type Status =
  | 'pending'
  | 'issuing'
  | 'needs_review'
  | 'issued'
  | 'failed'
  | 'refunded'
  /** The store's public word for a redemption that did not complete and gave the coins back (W-5). */
  | 'failed_refunded'
  | 'accepted'
  | 'duplicate'
  | 'rejected'
  | 'active'
  | 'trial'
  | 'past_due'
  | 'suspended'
  | 'draft'
  | 'published'
  | 'archived'
  | 'paid'
  | 'open';

const STATUS: Record<Status, { tone: Tone; label: string }> = {
  pending: { tone: 'warning', label: 'Pending' },
  issuing: { tone: 'info', label: 'Issuing' },
  needs_review: { tone: 'warning', label: 'Needs review' },
  issued: { tone: 'success', label: 'Issued' },
  failed: { tone: 'danger', label: 'Failed' },
  refunded: { tone: 'neutral', label: 'Refunded' },
  failed_refunded: { tone: 'danger', label: 'Failed, coins back' },
  accepted: { tone: 'success', label: 'Accepted' },
  duplicate: { tone: 'neutral', label: 'Duplicate (ignored)' },
  rejected: { tone: 'danger', label: 'Rejected' },
  active: { tone: 'success', label: 'Active' },
  trial: { tone: 'info', label: 'Trial' },
  past_due: { tone: 'warning', label: 'Past due' },
  suspended: { tone: 'danger', label: 'Suspended' },
  draft: { tone: 'warning', label: 'Draft' },
  published: { tone: 'success', label: 'Published' },
  archived: { tone: 'neutral', label: 'Archived' },
  paid: { tone: 'success', label: 'Paid' },
  open: { tone: 'warning', label: 'Open' },
};

export function StatusPill({ status, className }: { status: Status; className?: string }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} icon className={className}>
      {s.label}
    </Badge>
  );
}
