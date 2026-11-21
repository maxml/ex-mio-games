import { IssueDeadlineMs, RECOVERY_MODES } from '@ex-mio/contracts';
import type { AdapterEntry, AdapterRegistry } from './adapter';
import { casinoAEntry } from './casino-a.adapter';
import { casinoBEntry } from './casino-b.adapter';

/**
 * Adapter registry. `register()` is the choke point of two obligations: every adapter type declares
 * how it recovers a lost reply (`recoveryMode`) and how long a `not_found` can still be a casino that
 * has not seen the request (`issueDeadlineMs`, bounds 60 s to 7 days). Neither is defaulted.
 */
export function createAdapterRegistry(): AdapterRegistry {
  const entries = new Map<string, AdapterEntry>();
  return {
    register(entry) {
      if (typeof entry.type !== 'string' || entry.type === '') {
        throw new Error('adapter type is required');
      }
      if (!RECOVERY_MODES.includes(entry.recoveryMode)) {
        throw new Error(`adapter ${entry.type} must declare a recovery mode`);
      }
      if (!IssueDeadlineMs.safeParse(entry.issueDeadlineMs).success) {
        throw new Error(`adapter ${entry.type} must declare an issue deadline within bounds`);
      }
      if (typeof entry.create !== 'function')
        throw new Error(`adapter ${entry.type} has no factory`);
      if (entries.has(entry.type))
        throw new Error(`adapter type ${entry.type} is already registered`);
      entries.set(entry.type, entry);
    },
    get: (type) => entries.get(type),
    list: () => [...entries.values()],
  };
}

/** The registry with every casino this service speaks. Adding a casino is one `register` call here. */
export function createDefaultRegistry(): AdapterRegistry {
  const registry = createAdapterRegistry();
  registry.register(casinoAEntry);
  registry.register(casinoBEntry);
  return registry;
}
