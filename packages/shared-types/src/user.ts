import { z } from 'zod';

export const User = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type User = z.infer<typeof User>;

export const CreateUserInput = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
});
export type CreateUserInput = z.infer<typeof CreateUserInput>;
