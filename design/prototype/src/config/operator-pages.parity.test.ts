// A-PROTO-3 (operator IA spec, section 5; T4). Written by the test author from the spec.
// The prototype's copy of the operator page registry equals the web's original: the same page ids in
// the same order, the same groups, and the same access for every role. The web module is imported
// directly; it only imports types from @ex-mio/ui, which the prototype aliases to packages/ui.
//
// Mutations that must turn this red (re-applied by the test author, see the hand-off):
//   - in design/prototype/src/config/operator-pages.ts give Rules `access('write', 'read', 'none')`
//     (staff: read) -> "role access" fails on rules.staff;
//   - move Insights to group 'Operations' in the prototype copy -> "groups" fails.
import { describe, expect, it } from 'vitest';
import { OPERATOR_PAGES as WEB_PAGES } from '../../../../apps/web/src/layers/shared/config/operator-pages';
import { OPERATOR_PAGES as PROTO_PAGES } from './operator-pages';

const ROLES = ['admin', 'staff', 'support', 'prospect', 'platform'] as const;

describe('A-PROTO-3: the prototype page registry equals the web registry', () => {
  it('the web registry is the real one (not empty, the seven IA pages)', () => {
    // Literal list from spec section 2, so an empty or truncated import cannot pass vacuously.
    expect(WEB_PAGES.map((p) => p.id)).toEqual([
      'setup',
      'rules',
      'wheel',
      'store',
      'redemptions',
      'insights',
      'team',
    ]);
  });

  it('ids: the same pages in the same order', () => {
    expect(PROTO_PAGES.map((p) => p.id)).toEqual(WEB_PAGES.map((p) => p.id));
  });

  it('groups: every page sits in the same group', () => {
    expect(PROTO_PAGES.map((p) => [p.id, p.group])).toEqual(WEB_PAGES.map((p) => [p.id, p.group]));
  });

  it('role access: every (page, role) pair has the same access', () => {
    const table = (pages: typeof WEB_PAGES) =>
      pages.flatMap((p) => ROLES.map((r) => `${p.id}.${r}=${p.roles[r]}`));
    expect(table(PROTO_PAGES)).toEqual(table(WEB_PAGES));
    // Neither copy grants a role the other does not know about.
    for (const p of [...PROTO_PAGES, ...WEB_PAGES]) {
      expect(Object.keys(p.roles).sort()).toEqual([...ROLES].sort());
    }
  });
});
