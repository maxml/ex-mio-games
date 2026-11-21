'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  MioApiError,
  queryKeys,
  useMioApi,
  useMioMutation,
  usePlayerState,
} from '@/layers/shared/api';
import {
  ActivityList,
  Alert,
  Badge,
  Button,
  Card,
  CoinBalance,
  StatusPill,
  StoreItemCard,
  TabPanel,
  Tabs,
  Text,
  Toast,
  Wheel,
  Checkbox,
  Heading,
  themeStyle,
  useTheme,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { DepositResult } from '@/layers/shared/types';

type Tab = 'wheel' | 'store' | 'history';
const TABS: { id: Tab; label: string }[] = [
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Bonus Store' },
  { id: 'history', label: 'History' },
];
const SPIN_MS = 4200;

/**
 * The embeddable widget. Built only from `@ex-mio/ui`. The server decides every spin; this view
 * animates the result it is given and never chooses one. A spin or redeem is one request: the button
 * is busy from the first click until the answer is shown.
 */
export function PlayerWidgetView() {
  const { theme } = useTheme();
  const api = useMioApi();
  const qc = useQueryClient();
  const { data: player, isPending, isError, refetch } = usePlayerState();

  const [tab, setTab] = useState<Tab>('wheel');
  // The result is credited by the server when it answers. These hold only the presentation: the part
  // of the balance still "in the air" and the text announced after the wheel stops.
  const [reveal, setReveal] = useState<{ id: string; coins: number } | null>(null);
  const [result, setResult] = useState('');
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'danger' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const revealed = useRef(new Set<string>());
  const inFlight = useRef(false);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const deposit = useMioMutation<void, DepositResult>((a) => a.player.simulateDeposit(40));
  const casinoDown = useMioMutation((a, on: boolean) => a.player.setCasinoDown(on));

  if (isPending) {
    return (
      <Card aria-label="MIO Games widget" title="Daily Wheel">
        <Text role="status" tone="muted">
          Loading your wheel...
        </Text>
      </Card>
    );
  }
  if (isError || !player) {
    return (
      <Card aria-label="MIO Games widget" title="Daily Wheel">
        <Alert tone="danger">The wheel could not be loaded.</Alert>
        <Button className="mt-3" variant="secondary" onClick={() => void refetch()}>
          Try again
        </Button>
      </Card>
    );
  }

  // The prize is part of `player.coins` as soon as the server answered; hold it back until the wheel stops.
  const holding = reveal !== null && player.lastSpin?.id === reveal.id ? reveal.coins : 0;
  const balance = player.coins - holding;
  const spinning = reveal !== null;

  function finishReveal(id: string, coins: number) {
    if (revealed.current.has(id)) return;
    revealed.current.add(id);
    setReveal((r) => (r?.id === id ? null : r));
    setResult(`You won ${coins} coins`);
  }

  async function doSpin() {
    if (inFlight.current || spinning || !player || player.spins < 1) return;
    inFlight.current = true;
    setBusy(true);
    setResult('');
    try {
      const res = await api.player.spin(); // credited once, on the server
      setReveal({ id: res.id, coins: res.coins });
      await qc.invalidateQueries({ queryKey: queryKeys.player.all });
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      // Independent of the Wheel (a tab switch may unmount it): the reveal always ends.
      later(() => finishReveal(res.id, res.coins), reduce ? 150 : SPIN_MS + 300);
    } catch (e) {
      setToast({
        text:
          e instanceof MioApiError && e.code === 'no_spins'
            ? 'No spins left.'
            : 'The spin did not go through. Nothing was charged; try again.',
        tone: 'danger',
      });
      void qc.invalidateQueries({ queryKey: queryKeys.player.all });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function doDeposit() {
    const r = await deposit.mutateAsync().catch(() => null);
    if (!r) return setToast({ text: 'The deposit could not be simulated.', tone: 'danger' });
    setToast({
      text:
        r.granted > 0
          ? `Deposit of 40 EUR confirmed by the casino: ${r.granted} ${r.granted === 1 ? 'spin' : 'spins'} added.`
          : 'Deposit of 40 EUR confirmed, but it earns no spins under the casino rules (minimum deposit or daily cap).',
      tone: 'info',
    });
  }

  async function redeem(itemId: string) {
    if (busyItem) return;
    setBusyItem(itemId);
    try {
      await api.player.redeem(itemId);
      await qc.invalidateQueries({ queryKey: queryKeys.player.all });
    } catch {
      setToast({
        text: 'That item could not be redeemed. Your coins were not spent.',
        tone: 'danger',
      });
    } finally {
      setBusyItem(null);
    }
  }

  const history = player.history.filter((h) => !reveal || h.spinId !== reveal.id);
  const spinsLabel = `${player.spins} ${player.spins === 1 ? 'spin' : 'spins'} available`;
  const wheelSpin = player.lastSpin
    ? { id: player.lastSpin.id, index: player.lastSpin.index }
    : null;

  return (
    <div style={themeStyle(theme)} className="text-fg">
      <Card
        aria-label="MIO Games widget"
        title="Daily Wheel"
        actions={<CoinBalance coins={balance} />}
        description={spinsLabel}
      >
        {/* Always mounted, so the result is announced even when the Wheel tab is not showing. */}
        <div className="sr-only" role="status" aria-live="polite" data-testid="result-live">
          {result}
        </div>

        <Tabs
          tabs={TABS}
          value={tab}
          onChange={setTab}
          label="Widget sections"
          idPrefix="pw"
          className="mb-4"
        />
        <Toast
          message={toast?.text ?? ''}
          tone={toast?.tone}
          onDismiss={() => setToast(null)}
          className="mb-3 empty:hidden"
        />

        {tab === 'wheel' && (
          <TabPanel idPrefix="pw" id="wheel">
            <Wheel
              segments={player.wheel}
              spin={wheelSpin}
              onSpinEnd={(id) =>
                id === player.lastSpin?.id && finishReveal(id, player.lastSpin.coins)
              }
              size={300}
            />
            <Heading
              level={3}
              className="mt-3 min-h-7 text-center text-lg font-bold"
              data-testid="result-text"
            >
              {spinning ? 'Spinning...' : result}
            </Heading>
            <div className="mt-2 flex flex-col gap-2">
              <Button
                size="lg"
                onClick={() => void doSpin()}
                loading={busy || spinning}
                aria-disabled={player.spins < 1 || busy || spinning || undefined}
              >
                {player.spins < 1 ? 'No spins left' : 'Spin'}
              </Button>
              {player.spins < 1 && (
                <Text tone="muted" className="text-center">
                  Spins come from deposits. Make a deposit to get more.
                </Text>
              )}
              <Button
                variant="secondary"
                loading={deposit.isPending}
                onClick={() => void doDeposit()}
              >
                Simulate a 40 EUR deposit at the casino
              </Button>
            </div>
          </TabPanel>
        )}

        {tab === 'store' && (
          <TabPanel idPrefix="pw" id="store">
            <Checkbox
              className="mb-3 text-fg-muted"
              label="Demo: make the casino fail the next reward (shows failed, then refunded)"
              checked={player.casinoDown}
              onChange={(e) => casinoDown.mutate(e.target.checked)}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {player.store.map((it) => (
                <StoreItemCard
                  key={it.id}
                  item={it}
                  balance={balance}
                  busy={busyItem === it.id}
                  onRedeem={(i) => void redeem(i.id)}
                />
              ))}
            </div>
            <Heading level={3} className="mb-2 mt-5">
              Your redemptions
            </Heading>
            <ActivityList
              bordered
              empty="Nothing redeemed yet."
              items={player.redemptions.map((r) => ({
                id: r.id,
                title: r.item,
                trailing: (
                  <>
                    {r.status === 'refunded' && <Badge>{`+${r.coins} coins back`}</Badge>}
                    <StatusPill status={r.status} />
                  </>
                ),
              }))}
            />
          </TabPanel>
        )}

        {tab === 'history' && (
          <TabPanel idPrefix="pw" id="history">
            <ActivityList
              items={history.map((h) => ({
                id: h.id,
                title: h.what,
                subtitle: h.at,
                trailing: (
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      h.delta > 0 && 'text-success',
                      h.delta < 0 && 'text-fg-muted',
                    )}
                  >
                    {h.delta > 0 ? `+${h.delta}` : h.delta < 0 ? `${h.delta}` : 'spins'}
                  </span>
                ),
              }))}
            />
          </TabPanel>
        )}
      </Card>
    </div>
  );
}
