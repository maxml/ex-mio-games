'use client';

// Public API of the MIO client layer: the `MioApi` interface, its two adapters, the env switch and
// the React context the screens read it from.
import { createContext, useContext, type ReactNode } from 'react';
import type { MioApi } from './api';
import { createHttpApi } from './http';
import { createMockApi } from './mock';

export { MioApiError, type MioApi, type MioApiErrorCode } from './api';
export { createHttpApi } from './http';
export { createIsolatedMockApi, createMockApi } from './mock';

export type MioApiMode = 'mock' | 'http';

/** `NEXT_PUBLIC_MIO_API=http` selects the real services; anything else (or unset) is the mock. */
export function resolveMioApiMode(
  raw: string | undefined = process.env.NEXT_PUBLIC_MIO_API,
): MioApiMode {
  return raw === 'http' ? 'http' : 'mock';
}

let singleton: { mode: MioApiMode; api: MioApi } | null = null;

/** One adapter per tab: the mock's shared store must not be recreated between screens. */
export function getMioApi(mode: MioApiMode = resolveMioApiMode()): MioApi {
  if (!singleton || singleton.mode !== mode)
    singleton = { mode, api: mode === 'http' ? createHttpApi() : createMockApi() };
  return singleton.api;
}

const Ctx = createContext<MioApi | null>(null);

export function MioApiProvider({ api, children }: { api?: MioApi; children: ReactNode }) {
  return <Ctx.Provider value={api ?? getMioApi()}>{children}</Ctx.Provider>;
}

export function useMioApi(): MioApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useMioApi outside MioApiProvider');
  return api;
}
