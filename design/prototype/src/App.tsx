import { useEffect, type ReactNode } from 'react';
import {
  RoleSwitcher,
  SiteHeader,
  SkipLink,
  Text,
  ThemeSwitcher,
  Main,
  useTheme,
  type NavItem,
} from '@ex-mio/ui';
import { PROTO_ROLES, ROLE_OPTION_LABEL, landing, type ProtoRole } from './config/operator-pages';
import { navigate, resolveRoute, useRoute } from './router';
import { AdminScreen } from './screens/AdminConsole';
import { PlayerScreen } from './screens/PlayerWidget';
import { InsightsScreen } from './screens/operator/InsightsScreen';
import { RedemptionsScreen } from './screens/operator/RedemptionsScreen';
import { RulesScreen } from './screens/operator/RulesScreen';
import { SetupScreen } from './screens/operator/SetupScreen';
import { StoreScreen } from './screens/operator/StoreScreen';
import { TeamScreen } from './screens/operator/TeamScreen';
import { WheelScreen } from './screens/operator/WheelScreen';
import { appStore, useApp } from './state/store';

/** The top bar links only to the surface the role belongs to: no role gets a link into another role's pages. */
function siteItems(role: ProtoRole): NavItem[] {
  switch (role) {
    case 'platform':
      return [{ id: 'admin', label: 'Platform admin', href: '#/admin' }];
    case 'player':
      return [{ id: 'player', label: 'Player widget', href: '#/player' }];
    default:
      return [{ id: 'operator', label: 'Operator console', href: '#/operator' }];
  }
}

export function App() {
  const route = useRoute();
  const role = useApp((s) => s.session.role);
  const live = useApp((s) => s.operator.live);
  const { theme } = useTheme();
  const resolved = resolveRoute(route, role, { live });
  const redirectTo = resolved.kind === 'redirect' ? resolved.to : null;
  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true });
  }, [redirectTo]);

  let view: ReactNode = (
    <Text tone="muted" role="status">
      Redirecting
    </Text>
  );
  let current = 'operator';
  if (resolved.kind === 'operator') {
    const { pageId, step, denied } = resolved;
    const readOnly = resolved.access === 'read';
    switch (pageId) {
      case 'setup':
        view = <SetupScreen key="setup" step={step} denied={denied} />;
        break;
      case 'rules':
        view = <RulesScreen readOnly={readOnly} denied={denied} />;
        break;
      case 'wheel':
        view = <WheelScreen readOnly={readOnly} denied={denied} />;
        break;
      case 'store':
        view = <StoreScreen readOnly={readOnly} denied={denied} />;
        break;
      case 'redemptions':
        view = <RedemptionsScreen readOnly={readOnly} denied={denied} />;
        break;
      case 'insights':
        view = <InsightsScreen readOnly={readOnly} denied={denied} />;
        break;
      case 'team':
        view = <TeamScreen readOnly={readOnly} denied={denied} />;
        break;
    }
  } else if (resolved.kind === 'admin') {
    current = 'admin';
    view = <AdminScreen denied={resolved.denied} />;
  } else if (resolved.kind === 'player') {
    current = 'player';
    view = <PlayerScreen denied={resolved.denied} />;
  }

  return (
    <>
      <SkipLink />
      <SiteHeader items={siteItems(role)} current={current}>
        <ThemeSwitcher />
        <RoleSwitcher<ProtoRole>
          value={role}
          roles={PROTO_ROLES}
          labels={ROLE_OPTION_LABEL}
          onChange={(next) => {
            // Point the hash at the new role's landing first. The hashchange event fires after both
            // lines ran, so the old page is never judged against the new role (no stray access notice).
            navigate(landing(next, { live }));
            appStore.dispatch({ type: 'session/role', role: next });
          }}
        />
      </SiteHeader>
      <Main theme={resolved.kind === 'player' ? theme : undefined}>{view}</Main>
    </>
  );
}
