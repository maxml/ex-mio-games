import { useEffect, useRef, useState } from 'react';
import {
  AccessNotice,
  Button,
  Card,
  Checkbox,
  PlayerWidgetTemplate,
  Stack,
  Text,
  type ActivityItem,
  type RedeemStatus,
  type StoreItem,
} from '@ex-mio/ui';
import { WHEEL_REWARDS } from '../mock/data';
import { pageTitle } from '../config/operator-pages';
import { appStore, requestSpin, simulateDeposit, startRedeem, useApp } from '../state/store';

const SPIN_MS = 4200;

const REDEEM_STATUS: Partial<Record<string, RedeemStatus>> = {
  pending: 'pending',
  issuing: 'pending',
  failed: 'pending',
  issued: 'issued',
  refunded: 'failed_refunded',
};

/** The player's page: the embedded widget (one template) plus the sandbox casino's demo controls. */
export function PlayerScreen({ denied }: { denied?: string }) {
  const player = useApp((s) => s.player);
  const catalog = useApp((s) => s.operator.catalog);
  const live = useApp((s) => s.operator.live);
  // The result was credited in the store when the "server" answered. These two only hold the
  // presentation: the part of the balance still "in the air" and the text announced afterwards.
  const [reveal, setReveal] = useState<{ id: string; coins: number } | null>(null);
  const [result, setResult] = useState('');
  const [toast, setToast] = useState('');
  const timers = useRef<number[]>([]);
  const revealed = useRef(new Set<string>());
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  const spinning = reveal !== null;
  const balance = player.coins - (reveal?.coins ?? 0);

  function finishReveal(id: string, coins: number) {
    if (revealed.current.has(id)) return;
    revealed.current.add(id);
    setReveal((r) => (r?.id === id ? null : r));
    setResult(`You won ${coins} coins`);
  }
  function spin() {
    if (spinning || player.spins < 1) return;
    const res = requestSpin(); // credits once, inside the store
    if (!res) return;
    setResult('');
    setReveal({ id: res.id, coins: res.coins });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Independent of the Wheel: the reveal always ends.
    timers.current.push(
      window.setTimeout(() => finishReveal(res.id, res.coins), reduce ? 150 : SPIN_MS + 300),
    );
  }
  function deposit() {
    const granted = simulateDeposit();
    setToast(
      granted > 0
        ? `Deposit of 40 EUR confirmed by the casino: ${granted} ${granted === 1 ? 'spin' : 'spins'} added.`
        : 'Deposit of 40 EUR confirmed, but it earns no spins under the casino rules (minimum deposit or daily cap).',
    );
  }

  // The latest redemption of each item decides what its card shows.
  const redeemStatus: Record<string, RedeemStatus> = {};
  for (const r of [...player.redemptions].reverse()) {
    const s = REDEEM_STATUS[r.status];
    if (s) redeemStatus[r.itemId] = s;
  }
  const history: ActivityItem[] = player.history
    .filter((h) => !reveal || h.spinId !== reveal.id)
    .map((h) => ({
      id: h.id,
      title: h.what,
      subtitle: h.at,
      trailing: h.delta > 0 ? `+${h.delta}` : h.delta < 0 ? `${h.delta}` : 'spins',
    }));
  const items: StoreItem[] = catalog.filter((i) => i.visible);

  return (
    <Stack gap={6}>
      {denied && <AccessNotice role="Player" page={pageTitle(denied)} />}
      <PlayerWidgetTemplate
        environment={live === 'live' ? 'live' : 'sandbox'}
        balance={balance}
        spinsLeft={player.spins}
        segments={WHEEL_REWARDS}
        spin={player.lastSpin}
        result={spinning ? 'Spinning...' : result}
        busy={spinning}
        onSpin={spin}
        onSpinEnd={(id) => id === player.lastSpin?.id && finishReveal(id, player.lastSpin.coins)}
        items={items}
        redeemStatus={redeemStatus}
        onRedeem={(item) => startRedeem(item.id)}
        history={history}
      />
      <Card
        title="Sandbox casino (demo controls)"
        description="These stand in for the casino. A real player never sees them."
      >
        <Stack>
          <Stack row align="center">
            <Button variant="secondary" onClick={deposit}>
              Simulate a 40 EUR deposit at the casino
            </Button>
          </Stack>
          <Checkbox
            label="Make the casino fail the next reward (shows failed, then refunded)"
            checked={player.casinoDown}
            onChange={(e) => appStore.dispatch({ type: 'player/casinoDown', on: e.target.checked })}
          />
          {toast !== '' && (
            <Text role="status" tone="muted">
              {toast}
            </Text>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
