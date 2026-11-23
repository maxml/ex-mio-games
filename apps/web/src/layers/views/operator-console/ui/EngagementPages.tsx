'use client';

import { useEffect, useState } from 'react';
import { useMioMutation, type NewStoreItem } from '@/layers/shared/api';
import { rulesValid, spinsForDeposit } from '@/layers/shared/lib';
import type { RulesView } from '@/layers/shared/types';
import { RulesTemplate, StoreTemplate, WheelTemplate } from '@/layers/shared/ui';
import { RequireAccess, useOperatorPage } from '../model/shell';

const NO_RULES: RulesView = { min: 20, spins: 1, per: true, cap: 10 };

function rulesPreview(draft: RulesView): string {
  return rulesValid(draft)
    ? `Preview: a 40 EUR deposit earns ${Math.min(spinsForDeposit(draft, 40), draft.cap)} spin(s), a player gets spins from at most ${draft.cap} deposit(s).`
    : 'Values must be whole numbers, at least 1.';
}

/** Engagement: the deposit-to-spins rule. */
export function RulesPage() {
  return (
    <RequireAccess pageId="rules">
      {({ readOnly }) => <RulesBody readOnly={readOnly} />}
    </RequireAccess>
  );
}

function RulesBody({ readOnly }: { readOnly: boolean }) {
  const { s, shell, state, errorText } = useOperatorPage('rules');
  const save = useMioMutation<RulesView>((a, r) => a.operator.saveRules(r));
  const saved = s?.rules ?? NO_RULES;
  const [draft, setDraft] = useState<RulesView>(saved);
  // A save (here or from another tab) changes what "saved" means: the draft follows it.
  const key = JSON.stringify(saved);
  useEffect(() => setDraft(saved), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <RulesTemplate
      shell={shell}
      state={state}
      errorText={errorText}
      readOnly={readOnly}
      value={draft}
      onChange={setDraft}
      preview={rulesPreview(draft)}
      onSave={(v) => save.mutate(v)}
      busy={save.isPending}
    />
  );
}

/** Engagement: draft weights against the published version. */
export function WheelPage() {
  return (
    <RequireAccess pageId="wheel">
      {({ readOnly }) => <WheelBody readOnly={readOnly} />}
    </RequireAccess>
  );
}

function WheelBody({ readOnly }: { readOnly: boolean }) {
  const { s, shell, state, errorText } = useOperatorPage('wheel');
  const publish = useMioMutation<number[]>((a, w) => a.operator.publishWheel(w));
  const rewards = s?.wheel.rewards ?? [];
  const version = s?.wheel.version ?? 0;
  const [draft, setDraft] = useState<number[]>(rewards.map((r) => r.weight));
  // A publish (here or from another tab) changes what "published" means: drop the draft onto it.
  useEffect(() => setDraft(rewards.map((r) => r.weight)), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <WheelTemplate
      shell={shell}
      state={state}
      errorText={errorText}
      readOnly={readOnly}
      rows={rewards}
      weights={draft}
      onChangeWeight={(i, w) => setDraft((cur) => cur.map((x, j) => (j === i ? w : x)))}
      onPublish={(w) => publish.mutate(w)}
      versions={(s?.wheel.versions ?? []).map((v) => ({
        id: `v${v.version}`,
        version: v.version,
        status: v.state,
        at: v.publishedAt,
      }))}
      busy={publish.isPending}
    />
  );
}

/** Engagement: the bonus store catalog. Staff read it; only an admin changes it. */
export function StorePage() {
  return (
    <RequireAccess pageId="store">
      {({ readOnly }) => <StoreBody readOnly={readOnly} />}
    </RequireAccess>
  );
}

function StoreBody({ readOnly }: { readOnly: boolean }) {
  const { s, shell, state, errorText } = useOperatorPage('store');
  const add = useMioMutation<NewStoreItem>((a, input) => a.operator.createItem(input));
  const price = useMioMutation<{ id: string; price: number }>((a, v) =>
    a.operator.setPrice(v.id, v.price),
  );
  const visible = useMioMutation<{ id: string; on: boolean }>((a, v) =>
    a.operator.setVisible(v.id, v.on),
  );
  const items = (s?.catalog ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    description: i.description,
    priceCoins: i.priceCoins,
    visible: i.visible,
  }));
  return (
    <StoreTemplate
      shell={shell}
      state={state}
      errorText={errorText}
      readOnly={readOnly}
      items={items}
      onAddItem={(v) => add.mutate(v)}
      onPrice={(id, p) => price.mutate({ id, price: p })}
      onVisibility={(id, on) => visible.mutate({ id, on })}
    />
  );
}
