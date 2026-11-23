import { useEffect, useState } from 'react';
import { RulesTemplate, rulesValid, type RuleValues } from '@ex-mio/ui';
import { spinsForDeposit } from '../../state/reducer';
import { appStore, useApp } from '../../state/store';
import { useOperatorShell } from './shell';

function preview(draft: RuleValues): string {
  return rulesValid(draft)
    ? `Preview: a 40 EUR deposit earns ${Math.min(spinsForDeposit(draft, 40), draft.cap)} spin(s), a player gets spins from at most ${draft.cap} deposit(s).`
    : 'Values must be whole numbers, at least 1.';
}

/** Engagement: the deposit-to-spins rule. Saved rules are what the player widget uses on its next deposit. */
export function RulesScreen({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { shell } = useOperatorShell(denied);
  const saved = useApp((s) => s.operator.rules);
  const [draft, setDraft] = useState<RuleValues>(saved);
  // A save changes what "saved" means: the draft follows it.
  const key = JSON.stringify(saved);
  useEffect(() => setDraft(saved), [key]);
  return (
    <RulesTemplate
      shell={shell}
      readOnly={readOnly}
      value={draft}
      onChange={setDraft}
      preview={preview(draft)}
      onSave={(rules) => appStore.dispatch({ type: 'rules/save', rules })}
    />
  );
}
