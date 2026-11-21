'use client';

import { useQuery } from '@tanstack/react-query';
import { listUsers, queryKeys } from '@/layers/shared/api';

// Client island (ADR-0005 §4.1): reads `GET /api/users` via TanStack Query. It keys
// off `queryKeys.users.list()` (which spreads `users.all`), so the `user-create`
// feature's `invalidateQueries(users.all)` refetches this list after a successful
// create — the read side of the reference write -> invalidate -> refetch loop.
export function UsersList() {
  const { data, error, isPending, isFetching } = useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: listUsers,
  });

  if (isPending) {
    return <p className="text-sm text-neutral-400">Loading users…</p>;
  }
  if (error) {
    return <p className="text-sm text-destructive">Failed to load users.</p>;
  }
  if (data.length === 0) {
    return <p className="text-sm text-neutral-400">No users yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {isFetching ? <li className="text-xs text-neutral-600">Refreshing…</li> : null}
      {data.map((user) => (
        <li key={user.id} className="rounded-md border border-neutral-800 px-3 py-2 text-sm">
          <span className="font-medium">{user.name ?? 'Unnamed'}</span>{' '}
          <span className="text-neutral-400">{user.email}</span>
        </li>
      ))}
    </ul>
  );
}
