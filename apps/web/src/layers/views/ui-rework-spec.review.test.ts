// Hostile review of the operator UI rework (6488273..a531b7b, IA spec sections 5 and 7). Written by the
// reviewer. Review: dev-materials/2026-11-21-ex-mio-games/review-briefs/out/ui-rework-review.md.
//
// UIR-5 (major, missing acceptance item, it.fails): A-SHOT-1 is not delivered. There is no
//   apps/web/e2e/operator-roles.spec.ts and no docs/screens/operator-ia-*.png, so nothing in the range
//   can go red for it. Goes green when the spec and the ten screenshots exist and docs/screens/README.md
//   lists them.
// UIR-6 (minor, spec deviation, it.fails): section 7 moves the widget and admin markup into
//   PlayerWidgetTemplate (with SpinPanel) and AdminConsoleTemplate, and says the web views become "a hook,
//   a mapping, and one template". a531b7b rebuilt PlayerWidgetView and PlatformAdminView from primitives
//   instead; only the prototype uses the templates. So the Storybook guards on SpinPanel (double click,
//   aria-live result) and RedeemFlow protect the prototype, not the shipped widget, and web/prototype
//   parity for the widget is not real. Goes green when the web views render those templates.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '../../..');
const REPO = path.resolve(WEB, '../..');

describe('UIR-5 A-SHOT-1 screenshots per role', () => {
  const SHOTS = [
    ...['admin', 'staff', 'support'].flatMap((r) =>
      ['nav', 'landing'].map((k) => `operator-ia-${r}-${k}.png`),
    ),
    'operator-ia-admin-setup.png',
    'operator-ia-admin-rules.png',
    'operator-ia-admin-redemptions.png',
    'operator-ia-admin-insights.png',
  ];

  it('the paths this test reads exist (guard against a vacuous red)', () => {
    expect(existsSync(path.join(REPO, 'docs/screens/README.md'))).toBe(true);
    expect(existsSync(path.join(WEB, 'e2e'))).toBe(true);
  });

  // MISSING: e2e/operator-roles.spec.ts and docs/screens/operator-ia-*.png are absent at a531b7b.
  it('the Playwright spec exists and the ten screenshots are committed and listed', () => {
    expect(existsSync(path.join(WEB, 'e2e/operator-roles.spec.ts'))).toBe(true);
    const have = readdirSync(path.join(REPO, 'docs/screens'));
    const readme = readFileSync(path.join(REPO, 'docs/screens/README.md'), 'utf8');
    for (const f of SHOTS) {
      expect(have, f).toContain(f);
      expect(readme, f).toContain(f);
    }
  });
});

describe('UIR-6 the web widget and admin views render the section 7 templates', () => {
  const src = (f: string) => readFileSync(path.join(WEB, 'src/layers/views', f), 'utf8');

  it('the files this test reads exist (guard against a vacuous red)', () => {
    expect(src('player-widget/ui/PlayerWidgetView.tsx')).toContain(
      'export function PlayerWidgetView',
    );
    expect(src('platform-admin/ui/PlatformAdminView.tsx')).toContain('PlatformAdminView');
  });

  // DEVIATION: neither view imports its template; the widget does not use SpinPanel or RedeemFlow.
  it('PlayerWidgetView renders PlayerWidgetTemplate and PlatformAdminView AdminConsoleTemplate', () => {
    expect(src('player-widget/ui/PlayerWidgetView.tsx')).toMatch(/<PlayerWidgetTemplate\b/);
    expect(src('platform-admin/ui/PlatformAdminView.tsx')).toMatch(/<AdminConsoleTemplate\b/);
  });
});
