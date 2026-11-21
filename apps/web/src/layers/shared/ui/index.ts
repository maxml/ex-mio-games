// Public API for the `shared/ui` segment — the atomic-ish, domain-agnostic
// design system (Tailwind, ADR-0005 §6). Token-driven via apps/web/tailwind.config.ts
// + app/globals.css; token values are a SEED until you supply your design tokens.
export { Button, buttonVariants, type ButtonProps } from './Button';
export { Input, type InputProps } from './Input';
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './Card';
