import type { AnchorHTMLAttributes, HTMLAttributes } from 'react';
import { cn } from './cn';

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Document outline level; the look follows the level, not the other way round. */
  level?: 1 | 2 | 3;
}

const HEADING_SIZE = {
  1: 'text-2xl font-bold',
  2: 'text-lg font-semibold',
  3: 'text-base font-semibold',
} as const;

export function Heading({ level = 2, className, ...rest }: HeadingProps) {
  const Tag = `h${level}` as const;
  return <Tag className={cn('font-display', HEADING_SIZE[level], className)} {...rest} />;
}

export type TextTone = 'default' | 'muted' | 'success' | 'danger';
const TEXT_TONE: Record<TextTone, string> = {
  default: 'text-fg',
  muted: 'text-fg-muted',
  success: 'text-success',
  danger: 'text-danger',
};
const TEXT_SIZE = { xs: 'text-xs', sm: 'text-sm', md: 'text-base' } as const;

export interface TextProps extends HTMLAttributes<HTMLParagraphElement> {
  tone?: TextTone;
  size?: keyof typeof TEXT_SIZE;
  strong?: boolean;
}

/** A paragraph. Tone is colour plus (where it matters) words; never colour alone. */
export function Text({ tone = 'default', size = 'sm', strong, className, ...rest }: TextProps) {
  return (
    <p
      className={cn(TEXT_TONE[tone], TEXT_SIZE[size], strong && 'font-semibold', className)}
      {...rest}
    />
  );
}

export function Link({ className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a className={cn('font-semibold underline', className)} {...rest} />;
}
