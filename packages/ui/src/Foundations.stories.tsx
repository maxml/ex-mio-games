import type { Meta, StoryObj } from '@storybook/react';
import { MIO_DEFAULT, THEMES } from './theme/theme';

// Foundations: the token set, rendered. Use the "Tenant theme" toolbar to see every theme.
// Colours come only from the tokens (bg-*, text-*, border-* utilities), never from raw values.

const meta = { title: 'Foundations/Tokens' } satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const SURFACES = [
  ['bg', 'bg-bg'],
  ['surface', 'bg-surface'],
  ['surface-2', 'bg-surface-2'],
  ['primary', 'bg-primary'],
  ['accent', 'bg-accent'],
  ['coin', 'bg-coin'],
] as const;

const STATUSES = [
  ['success', 'text-success'],
  ['warning', 'text-warning'],
  ['danger', 'text-danger'],
  ['info', 'text-info'],
] as const;

export const Colours: Story = {
  render: () => (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {SURFACES.map(([name, cls]) => (
          <div
            key={name}
            className={`${cls} rounded-md border border-border p-4 text-sm font-semibold text-fg`}
          >
            {name}
          </div>
        ))}
      </div>
      <ul className="flex flex-wrap gap-4 rounded-md border border-border bg-surface p-4">
        {STATUSES.map(([name, cls]) => (
          <li key={name} className={`${cls} text-sm font-semibold`}>
            {name} text
          </li>
        ))}
      </ul>
    </div>
  ),
};

/** The themes the app can apply: MIO_DEFAULT plus the tenant files in src/theme/tenants. */
export const TenantThemes: Story = {
  render: () => (
    <ul className="grid gap-2">
      {THEMES.map((t) => (
        <li key={t.id} className="rounded-md border border-border bg-surface p-3 text-sm">
          <span className="font-semibold">{t.name}</span>
          <span className="text-fg-muted">
            {' '}
            ({t.id}
            {t.id === MIO_DEFAULT.id
              ? ', no overrides'
              : `, ${Object.keys(t.tokens).length} overrides`}
            )
          </span>
        </li>
      ))}
    </ul>
  ),
};

export const ShapeAndType: Story = {
  render: () => (
    <div className="grid gap-3">
      <div className="flex gap-3">
        {(['rounded-sm', 'rounded-md', 'rounded-lg'] as const).map((r) => (
          <div key={r} className={`${r} border border-input-border bg-surface p-4 text-sm`}>
            {r}
          </div>
        ))}
      </div>
      <p className="font-display text-xl font-bold">Display face</p>
      <p className="font-sans text-sm">Body face</p>
      <div className="rounded-lg bg-surface p-4 shadow-card text-sm">shadow-card</div>
    </div>
  ),
};
