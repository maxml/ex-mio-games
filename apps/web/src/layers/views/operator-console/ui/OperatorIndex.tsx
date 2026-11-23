'use client';

import { useEffect } from 'react';
import { useOperatorState } from '@/layers/shared/api';
import { useRouter } from 'next/navigation';
import { landing } from '@/layers/shared/config/operator-pages';
import { Text } from '@/layers/shared/ui';
import { useConsoleRole } from '../model/role';
import { useConsoleBase } from '../model/shell';

/** `/operator` itself: redirects to the role's landing page (admin: Setup until live, then Redemptions). */
export function OperatorIndex() {
  const { role, ready } = useConsoleRole();
  const state = useOperatorState();
  const router = useRouter();
  const base = useConsoleBase();
  // An admin's landing depends on whether the integration is live, so wait for that read to settle.
  const settled = ready && (role !== 'admin' || !state.isPending);
  const to = settled ? landing(role, state.data) : null;
  useEffect(() => {
    if (to) router.replace(`${base}${to}`);
  }, [router, base, to]);
  return (
    <Text tone="muted" role="status">
      Opening your console
    </Text>
  );
}
