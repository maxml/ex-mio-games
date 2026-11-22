/** Joins class names, skipping falsy values. (In packages/ui this becomes clsx + tailwind-merge.) */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
