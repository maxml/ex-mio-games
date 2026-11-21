'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createUser, queryKeys } from '@/layers/shared/api';
import type { CreateUserInput, User } from '@/layers/shared/types';

// Typed TanStack Query mutation for the `user-create` feature (ADR-0005 §4.2).
// `mutationFn` posts through the shared `http` client (`shared/api`); on success
// it invalidates the users query key so any reader of that key — e.g. the
// `users-list` widget — refetches. The mutation rejects with the shared
// `HttpError` envelope (typed loosely as `Error` here; the form narrows it with
// `isHttpError` to map 400 `issues` / 409 duplicate onto fields).
export function useCreateUser() {
  const queryClient = useQueryClient();

  return useMutation<User, Error, CreateUserInput>({
    mutationFn: (input) => createUser(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
    },
  });
}
