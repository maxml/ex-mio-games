// Centralized, typed TanStack Query key factory (ADR-0013 §8: "Query key factory —
// централізовані ключі (typed)"). One source of truth for cache keys keeps
// invalidation precise: WS handlers and mutations target the same key a query
// reads from, instead of re-typing string arrays at each call site.
//
// Convention: every domain exposes an `all` root plus narrower derived keys that
// spread it, so `invalidateQueries({ queryKey: queryKeys.health.all })` matches
// every health query. `as const` preserves literal tuple types end-to-end.
export const queryKeys = {
  health: {
    all: ['health'] as const,
    status: () => [...queryKeys.health.all, 'status'] as const,
  },
  users: {
    all: ['users'] as const,
    list: () => [...queryKeys.users.all, 'list'] as const,
  },
  player: {
    all: ['player'] as const,
    state: () => [...queryKeys.player.all, 'state'] as const,
  },
  operator: {
    all: ['operator'] as const,
    state: () => [...queryKeys.operator.all, 'state'] as const,
  },
  admin: {
    all: ['admin'] as const,
    overview: () => [...queryKeys.admin.all, 'overview'] as const,
  },
} as const;
