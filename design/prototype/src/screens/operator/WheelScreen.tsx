import { useEffect, useState } from 'react';
import { WheelTemplate } from '@ex-mio/ui';
import { WHEEL_REWARDS } from '../../mock/data';
import { appStore, useApp } from '../../state/store';
import { useOperatorShell } from './shell';

const ROWS = WHEEL_REWARDS.map((r) => ({ id: r.id, coins: r.coins }));

/** Engagement: draft weights against the published version. A publish is what the player's next spin uses. */
export function WheelScreen({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { shell } = useOperatorShell(denied);
  const { weights: published, version, versions } = useApp((s) => s.operator.wheel);
  const [draft, setDraft] = useState<number[]>(published);
  // A publish changes what "published" means: drop the draft onto it.
  useEffect(() => setDraft(published), [version]);
  return (
    <WheelTemplate
      shell={shell}
      readOnly={readOnly}
      rows={ROWS}
      weights={draft}
      onChangeWeight={(i, w) => setDraft((cur) => cur.map((x, j) => (j === i ? w : x)))}
      onPublish={(weights) => appStore.dispatch({ type: 'wheel/publish', weights })}
      versions={versions.map((v) => ({
        id: `v${v.version}`,
        version: v.version,
        status: v.state === 'published' ? 'published' : 'archived',
        at: v.publishedAt,
      }))}
    />
  );
}
