'use client';

import { useForm, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { isHttpError, type HttpError } from '@/layers/shared/api';
import { CreateUserInput } from '@/layers/shared/types';
import { Button, Input } from '@/layers/shared/ui';
import { useCreateUser } from '../api/useCreateUser';

// Reference "create user" flow (ADR-0005 §4.2): react-hook-form drives the inputs,
// `zodResolver` validates them against the *shared* `CreateUserInput` Zod schema
// (single source of truth with the API), and submit runs the typed TanStack
// Query mutation in `../api/useCreateUser` — which posts through the shared
// `http` client to the real `POST /api/users` and invalidates the users key.
//
// A login form is identical in shape; it only differs in schema + endpoint, and
// the auth endpoints are not wired yet (auth is app-specific), so this models `/api/users` to
// actually run against the baseline today.

const GENERIC_ERROR = 'Something went wrong. Please try again.';

interface ServerIssue {
  path: Array<string | number>;
  message: string;
}

/** Narrow the server error envelope's `issues` (unknown) to typed Zod issues. */
function toServerIssues(issues: unknown): ServerIssue[] {
  if (!Array.isArray(issues)) return [];
  const result: ServerIssue[] = [];
  for (const issue of issues) {
    if (
      issue !== null &&
      typeof issue === 'object' &&
      Array.isArray((issue as { path?: unknown }).path) &&
      typeof (issue as { message?: unknown }).message === 'string'
    ) {
      result.push({
        path: (issue as ServerIssue).path,
        message: (issue as ServerIssue).message,
      });
    }
  }
  return result;
}

/** Map an `HttpError` from the API onto react-hook-form field / root errors. */
function applyServerError(error: HttpError, setError: UseFormSetError<CreateUserInput>): void {
  // 409: duplicate email (server body: `{ message: 'email already exists' }`).
  if (error.status === 409) {
    setError('email', { type: 'server', message: error.message });
    return;
  }
  // 400: Zod validation failures echoed as `issues` in the error envelope.
  if (error.status === 400) {
    let mappedField = false;
    for (const issue of toServerIssues(error.issues)) {
      const field = issue.path[0];
      if (field === 'email' || field === 'name') {
        setError(field, { type: 'server', message: issue.message });
        mappedField = true;
      }
    }
    if (mappedField) return;
  }
  // Network / 500 / unmapped: surface as a form-level (root) error.
  setError('root.server', { type: 'server', message: error.message || GENERIC_ERROR });
}

export function CreateUserForm() {
  const mutation = useCreateUser();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(CreateUserInput),
    // `name` defaults to `undefined` (not `''`) so an untouched optional field
    // passes the schema; `setValueAs` keeps it `undefined` if typed then cleared.
    defaultValues: { email: '', name: undefined },
  });

  const onSubmit = handleSubmit((values) => {
    clearErrors('root');
    mutation.mutate(values, {
      onSuccess: () => reset(),
      onError: (error) => {
        if (isHttpError(error)) applyServerError(error, setError);
        else setError('root.server', { type: 'server', message: GENERIC_ERROR });
      },
    });
  });

  const pending = mutation.isPending;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="create-user-email" className="text-sm font-medium">
          Email
        </label>
        <Input
          id="create-user-email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          aria-invalid={errors.email ? true : undefined}
          {...register('email')}
        />
        {errors.email ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="create-user-name" className="text-sm font-medium">
          Name <span className="text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="create-user-name"
          autoComplete="name"
          placeholder="Ada Lovelace"
          aria-invalid={errors.name ? true : undefined}
          {...register('name', { setValueAs: (value) => (value === '' ? undefined : value) })}
        />
        {errors.name ? (
          <p role="alert" className="text-sm text-destructive">
            {errors.name.message}
          </p>
        ) : null}
      </div>

      {errors.root?.server ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.root.server.message}
        </p>
      ) : null}

      {mutation.isSuccess && !pending ? (
        <p role="status" className="text-sm text-primary">
          User created.
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create user'}
      </Button>
    </form>
  );
}
