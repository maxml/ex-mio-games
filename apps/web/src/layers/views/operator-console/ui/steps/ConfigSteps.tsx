'use client';

import { useEffect, useState } from 'react';
import { MioApiError, useMioMutation } from '@/layers/shared/api';
import {
  expectedPayout,
  rulesValid,
  sameWeights,
  spinsForDeposit,
  weightsValid,
} from '@/layers/shared/lib';
import type { CatalogItemView, RulesView } from '@/layers/shared/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  Link,
  RuleEditor,
  StatTile,
  StatusPill,
  Table,
  Text,
  WeightTable,
} from '@/layers/shared/ui';
import type { StepProps } from './types';

const DEFAULT_RULES: RulesView = { min: 20, spins: 1, per: true, cap: 10 };

export function RulesStep({ s, nav }: StepProps) {
  const saved = s.rules;
  const save = useMioMutation<RulesView>((a, r) => a.operator.saveRules(r));
  const [draft, setDraft] = useState<RulesView>(saved);
  const invalid = !rulesValid(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const preview = invalid
    ? 'Values must be whole numbers, at least 1.'
    : `Preview: a 40 EUR deposit earns ${Math.min(spinsForDeposit(draft, 40), draft.cap)} spin(s), at most ${draft.cap} per player per day.`;
  return (
    <Card
      title="Spin rules"
      description="When does a deposit earn spins?"
      actions={
        s.rulesSaved && !dirty ? (
          <StatusPill status="published" />
        ) : dirty ? (
          <Badge tone="warning" icon>
            Unsaved changes
          </Badge>
        ) : null
      }
    >
      <RuleEditor value={draft} onChange={setDraft} preview={preview} />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          disabled={invalid || (!dirty && s.rulesSaved)}
          loading={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          Save rules
        </Button>
        <Button variant="secondary" onClick={() => setDraft({ ...DEFAULT_RULES })}>
          Reset to defaults
        </Button>
        {s.rulesSaved && !dirty && (
          <Text tone="success" role="status">
            Rules saved. The player widget uses them now; try the deposit button there (
            <Link href="../embed/widget">open</Link>).
          </Text>
        )}
      </div>
      {nav({ canContinue: s.rulesSaved && !dirty, hint: 'Save the rules to continue.' })}
    </Card>
  );
}

export function WheelStep({ s, nav }: StepProps) {
  const { rewards, version, versions } = s.wheel;
  const published = rewards.map((r) => r.weight);
  const publish = useMioMutation<number[]>((a, w) => a.operator.publishWheel(w));
  const [draft, setDraft] = useState<number[]>(published);
  // A publish (here or from another tab) changes what "published" means: drop the draft onto it.
  useEffect(() => setDraft(rewards.map((r) => r.weight)), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = draft.reduce((a, b) => a + b, 0);
  const ev = expectedPayout(
    rewards.map((r) => r.coins),
    draft,
  );
  const bad = !weightsValid(draft);
  const dirty = !sameWeights(draft, published);
  const topIndex = rewards.reduce(
    (best, r, i, all) => (r.coins > (all[best]?.coins ?? 0) ? i : best),
    0,
  );
  const topW = draft[topIndex] ?? 0;
  return (
    <div className="grid gap-4">
      <Card
        title="Wheel reward table"
        description="Probabilities come from weights. Publishing creates a new version that the player widget uses for the next spin; spins already made keep the version they used."
        actions={
          dirty ? (
            <Badge tone="warning" icon>
              Draft changes on v{version}
            </Badge>
          ) : (
            <Badge tone="success" icon>
              v{version} published
            </Badge>
          )
        }
      >
        <WeightTable
          rows={rewards}
          weights={draft}
          onChange={(i, w) => setDraft((cur) => cur.map((x, j) => (j === i ? w : x)))}
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatTile label="Expected payout per spin" value={`${ev.toFixed(1)} coins`} />
          <StatTile label="Total weight" value={total.toFixed(1)} />
          <StatTile
            label="Top prize odds"
            value={
              topW > 0 && total > 0
                ? `1 in ${Math.round(total / topW).toLocaleString('en-US')}`
                : 'n/a'
            }
          />
        </div>
        {bad && (
          <Text tone="danger" className="mt-3" role="alert">
            Every weight must be greater than 0.
          </Text>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={bad || !dirty}
            loading={publish.isPending}
            onClick={() => publish.mutate(draft)}
          >
            Publish as v{version + 1}
          </Button>
          {dirty && (
            <Button variant="secondary" onClick={() => setDraft(published)}>
              Discard changes
            </Button>
          )}
          {!dirty && (
            <Text tone="muted">
              Change a weight to publish a new version.{' '}
              <Link href="../embed/widget">Open the player widget</Link> to spin on v{version}.
            </Text>
          )}
        </div>
        {publish.error instanceof MioApiError && (
          <Alert tone="danger" className="mt-3">
            {publish.error.message}
          </Alert>
        )}
      </Card>
      <Card title="Versions" flush>
        <Table
          caption="Wheel table versions"
          rowKey={(v) => String(v.version)}
          rows={versions}
          columns={[
            { key: 'v', header: 'Version', render: (v) => `v${v.version}` },
            { key: 's', header: 'State', render: (v) => <StatusPill status={v.state} /> },
            { key: 'd', header: 'Published', render: (v) => v.publishedAt, hideOnMobile: true },
            { key: 'n', header: 'Note', render: (v) => v.note, hideOnMobile: true },
          ]}
        />
      </Card>
      {nav({ canContinue: !dirty, hint: 'Publish or discard the draft to continue.' })}
    </div>
  );
}

function PriceInput({ item }: { item: CatalogItemView }) {
  const setPrice = useMioMutation<number>((a, p) => a.operator.setPrice(item.id, p));
  const [text, setText] = useState(String(item.priceCoins));
  const n = Number(text);
  const ok = text.trim() !== '' && Number.isInteger(n) && n >= 1;
  return (
    <span className="inline-flex flex-col items-end">
      <Input
        size="sm"
        className="w-24 text-right"
        aria-label={`Price of ${item.name}`}
        type="number"
        min={1}
        step={1}
        value={text}
        invalid={!ok}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isInteger(v) && v >= 1) setPrice.mutate(v);
        }}
      />
      {!ok && (
        <span role="alert" className="mt-1 text-xs text-danger">
          Whole number, at least 1
        </span>
      )}
    </span>
  );
}

export function StoreStep({ s, nav }: StepProps) {
  const setVisible = useMioMutation<{ id: string; on: boolean }>((a, v) =>
    a.operator.setVisible(v.id, v.on),
  );
  return (
    <div className="grid gap-4">
      <Card
        title="Bonus Store catalog"
        description="What players can buy with coins. Price and visibility changes show in the player widget at once."
        flush
      >
        <Table
          caption="Store catalog"
          rowKey={(i) => i.id}
          rows={s.catalog}
          columns={[
            {
              key: 'n',
              header: 'Item',
              render: (i) => (
                <span>
                  <span className="font-semibold">{i.name}</span>
                  <span className="block text-xs text-fg-muted">{i.description}</span>
                </span>
              ),
            },
            {
              key: 'p',
              header: 'Price (coins)',
              align: 'right',
              render: (i) => <PriceInput item={i} />,
            },
            {
              key: 's',
              header: 'Stock',
              align: 'right',
              render: (i) => (i.stock === undefined ? 'Unlimited' : i.stock),
              hideOnMobile: true,
            },
            {
              key: 'a',
              header: 'Visible',
              render: (i) => (
                <Checkbox
                  hideLabel
                  label={`Visible to players: ${i.name}`}
                  checked={i.visible}
                  onChange={() => setVisible.mutate({ id: i.id, on: !i.visible })}
                  trailing={<StatusPill status={i.visible ? 'published' : 'draft'} />}
                />
              ),
            },
          ]}
        />
      </Card>
      {nav()}
    </div>
  );
}
