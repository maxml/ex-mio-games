import { z } from 'zod';
import { Uuid } from './ids';

// HTTP DTOs. Every controller parses its input with one of these schemas;
// nothing reads `request.body` or `request.params` raw.

export const ErrorBody = z.object({
  message: z.string(),
  /** Stable machine-readable code (e.g. `out_of_stock`); absent on generic framework errors. */
  code: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// identity
export const CreateTenantRequest = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single dashes'),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const Tenant = z.object({
  id: Uuid,
  name: z.string(),
  slug: z.string(),
  created_at: z.string().datetime(),
});
export type Tenant = z.infer<typeof Tenant>;

export const TenantIdParam = z.object({ id: Uuid });

// payments
export const CreateCreditRequest = z.object({
  player_id: Uuid,
  amount: z.number().int().positive().max(1_000_000),
});
export type CreateCreditRequest = z.infer<typeof CreateCreditRequest>;

export const Credit = z.object({
  id: Uuid,
  player_id: Uuid,
  amount: z.number().int(),
  created_at: z.string().datetime(),
});
export type Credit = z.infer<typeof Credit>;

// engagement
export const TenantProjection = z.object({
  tenant_id: Uuid,
  name: z.string(),
  slug: z.string(),
  applied_count: z.number().int().nonnegative(),
});
export type TenantProjection = z.infer<typeof TenantProjection>;

/** Request header shared by the coin-moving endpoints. No header ever names a tenant or a principal. */
export const HEADER_IDEMPOTENCY_KEY = 'idempotency-key';
