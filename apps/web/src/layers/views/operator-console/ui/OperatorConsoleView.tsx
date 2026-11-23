'use client';

import { SetupPage } from './SetupPage';

/**
 * The first operator page, kept under its old name: Setup, the guided path from signup to a live
 * integration. The rest of the console is one page per job (see `OPERATOR_PAGES`).
 */
export function OperatorConsoleView() {
  return <SetupPage />;
}
