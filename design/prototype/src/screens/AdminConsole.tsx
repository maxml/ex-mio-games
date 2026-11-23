import { AccessNotice, AdminConsoleTemplate, ROLE_LABEL, Stack, type TenantRow } from '@ex-mio/ui';
import { FUNNEL, TENANTS } from '../mock/data';
import { landing, pageTitle } from '../config/operator-pages';
import { navigate } from '../router';
import { appStore } from '../state/store';

const TENANT_ROWS: TenantRow[] = TENANTS.map((t) => ({
  id: t.id,
  name: t.name,
  plan: t.plan,
  status: t.status as TenantRow['status'],
  mrrEur: t.mrr,
}));

/**
 * Platform admin (`#/admin`): tenants, MRR, the platform funnel and the act-as form. Starting an acting
 * session switches the prototype to the Support role, which then sees only Insights and Team.
 */
export function AdminScreen({ denied }: { denied?: string }) {
  return (
    <Stack gap={4}>
      {denied && <AccessNotice role={ROLE_LABEL.platform} page={pageTitle(denied)} />}
      <AdminConsoleTemplate
        tenants={TENANT_ROWS}
        funnel={FUNNEL}
        onAct={(_tenantId, reason) => {
          navigate(landing('support'));
          appStore.dispatch({ type: 'session/act', reason });
        }}
      />
    </Stack>
  );
}
