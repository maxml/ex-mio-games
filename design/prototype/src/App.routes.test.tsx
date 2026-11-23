// @vitest-environment jsdom
// A-PROTO-1 (operator IA spec, sections 4 and 5; T4). Written by the test author from the spec.
// Each hash route renders its page, and the role switcher in the header sets the operator nav to the
// A-NAV-1 sets. The expected pages and nav sets are LITERAL tables here, not read from OPERATOR_PAGES.
//
// Mutations that must turn this red (re-applied by the test author, see the hand-off):
//   - in src/config/operator-pages.ts give Rules staff access `read` -> the Staff nav set test fails
//     (Rules appears for Staff), as A-NAV-1's mutation does on the web;
//   - in src/App.tsx render <WheelScreen> for `case 'rules'` -> the #/operator/engagement/rules route
//     test fails (heading "Wheel", not "Rules").
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@ex-mio/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { ProtoRole } from './config/operator-pages';
import { appStore } from './state/store';

/** A-NAV-1, spec section 5, copied as literals. */
const NAV: Record<'admin' | 'staff' | 'support', string[]> = {
  admin: ['Setup', 'Rules', 'Wheel', 'Store', 'Redemptions', 'Insights', 'Team'],
  staff: ['Store', 'Redemptions', 'Insights', 'Team'],
  support: ['Insights', 'Team'],
};

/** Route -> the page's h1 and the nav entry marked current. Titles are the @ex-mio/ui templates'. */
const OPERATOR_ROUTES: { hash: string; h1: string; current: string }[] = [
  { hash: '#/operator/setup', h1: 'Set up your integration', current: 'Setup' },
  { hash: '#/operator/setup/plan', h1: 'Set up your integration', current: 'Setup' },
  { hash: '#/operator/engagement/rules', h1: 'Rules', current: 'Rules' },
  { hash: '#/operator/engagement/wheel', h1: 'Wheel', current: 'Wheel' },
  { hash: '#/operator/engagement/store', h1: 'Bonus store', current: 'Store' },
  { hash: '#/operator/operations/redemptions', h1: 'Redemptions', current: 'Redemptions' },
  { hash: '#/operator/insights', h1: 'Usage and invoices', current: 'Insights' },
  { hash: '#/operator/team', h1: 'Team and settings', current: 'Team' },
];

function setRole(role: ProtoRole) {
  appStore.dispatch({ type: 'session/role', role });
}

function renderAt(hash: string) {
  window.location.hash = hash;
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
}

const h1 = () => screen.getByRole('heading', { level: 1 });
const operatorNav = () => screen.queryByRole('navigation', { name: 'Operator pages' });
const navLabels = () =>
  within(operatorNav()!)
    .getAllByRole('link')
    .map((a) => a.textContent?.trim());

beforeEach(() => {
  setRole('admin');
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('A-PROTO-1: each hash route renders its page', () => {
  for (const r of OPERATOR_ROUTES) {
    it(`${r.hash} (admin) renders "${r.h1}" with "${r.current}" current in the nav`, async () => {
      renderAt(r.hash);
      await waitFor(() => expect(h1()).toHaveProperty('textContent', r.h1));
      const current = within(operatorNav()!).getByRole('link', { current: 'page' });
      expect(current.textContent?.trim()).toBe(r.current);
      expect(window.location.hash).toBe(r.hash);
    });
  }

  it('#/player (player) renders the player widget', async () => {
    setRole('player');
    renderAt('#/player');
    await waitFor(() => expect(h1()).toHaveProperty('textContent', 'Wheel of Fortune'));
    expect(operatorNav()).toBeNull();
  });

  it('#/admin (platform) renders the platform admin console', async () => {
    setRole('platform');
    renderAt('#/admin');
    await waitFor(() => expect(h1()).toHaveProperty('textContent', 'Platform admin'));
    expect(operatorNav()).toBeNull();
  });

  it("#/operator redirects to the role's landing (admin, not live -> setup; staff -> redemptions)", async () => {
    renderAt('#/operator');
    await waitFor(() => expect(window.location.hash).toBe('#/operator/setup'));
    await waitFor(() => expect(h1()).toHaveProperty('textContent', 'Set up your integration'));
    cleanup();
    setRole('staff');
    renderAt('#/operator');
    await waitFor(() => expect(window.location.hash).toBe('#/operator/operations/redemptions'));
    await waitFor(() => expect(h1()).toHaveProperty('textContent', 'Redemptions'));
  });
});

describe('A-PROTO-1: the role switcher sets the nav to the A-NAV-1 sets', () => {
  it('admin -> staff -> support -> admin, each with exactly its set', async () => {
    renderAt('#/operator/setup');
    await waitFor(() => expect(navLabels()).toEqual(NAV.admin));
    for (const role of ['staff', 'support', 'admin'] as const) {
      act(() => {
        fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), {
          target: { value: role },
        });
      });
      await waitFor(() => expect(navLabels()).toEqual(NAV[role]));
      // The switcher really changed the role in the store, which is what the nav reads.
      expect(appStore.get().session.role).toBe(role);
    }
  });

  it('switching to platform admin leaves the operator console (no operator nav)', async () => {
    renderAt('#/operator/setup');
    await waitFor(() => expect(navLabels()).toEqual(NAV.admin));
    act(() => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Role' }), {
        target: { value: 'platform' },
      });
    });
    await waitFor(() => expect(h1()).toHaveProperty('textContent', 'Platform admin'));
    expect(operatorNav()).toBeNull();
  });
});
