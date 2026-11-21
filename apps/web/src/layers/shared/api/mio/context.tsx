'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { MioApi } from './api';
import { getMioApi } from './select';

const Ctx = createContext<MioApi | null>(null);

export function MioApiProvider({ api, children }: { api?: MioApi; children: ReactNode }) {
  return <Ctx.Provider value={api ?? getMioApi()}>{children}</Ctx.Provider>;
}

export function useMioApi(): MioApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useMioApi outside MioApiProvider');
  return api;
}
