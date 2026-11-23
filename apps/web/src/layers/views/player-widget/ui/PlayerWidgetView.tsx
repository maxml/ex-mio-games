'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  MioApiError,
  isOutcomeUnknown,
  queryKeys,
  resolveMioApiMode,
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
  Grid,
  LiveRegion,
  SignedAmount,
  Stack,
  StatusPill,
  StoreItemCard,
  TabPanel,
  Tabs,
  Text,
  ThemeScope,
  Toast,
  Wheel,
  Checkbox,
  Heading,
} from '@/layers/shared/ui';
import type { DepositResult } from '@/layers/shared/types';

type Tab = 'wheel' | 'store' | 'history';
const TABS: { id: Tab; label: string }[] = [
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Bonus Store' },
  { id: 'history', label: 'History' },
];
const SPIN_MS = 4200;
/** After a spin the balance is re-read this often, at most this many times (about 32 s). */
const BALANCE_POLL_MS = 800;
const BALANCE_POLL_MAX = 40;
/** Waits between re-queries (same idempotency key) after a spin whose outcome is unknown. */
const DEFAULT_RECHECK_MS = [1000, 2000, 4000];

/**
 * The embeddable widget. Built only from `@ex-mio/ui`. The server decides every spin; this view
 * animates the result it is given and never chooses one. A spin or redeem is one request: the button
 * is busy from the first click until the answer is shown.
 *
 * D-1: the spin answer carries the reward, not the balance; payments credits the coins later. So the
 * widget never computes a balance from a spin. It shows the reward as "+N pending" next to the last
 * confirmed balance and re-reads the balance until a read contains the credit.
 */
export function PlayerWidgetView({
  recheckDelaysMs = DEFAULT_RECHECK_MS,
}: {
  recheckDelaysMs?: readonly number[];
} = {}) {
  const api = useMioApi();
  const qc = useQueryClient();
  const { data: player, isPending, isError, refetch } = usePlayerState();

  // The two sandbox-casino demo controls exist in mock mode only. Live, the casino sends the deposits (the
  // sandbox routes need a per-tenant target the stack does not hold: known-gaps G-10).
  const demoControls = resolveMioApiMode() === 'mock';
  const [tab, setTab] = useState<Tab>('wheel');
  // `reveal` is the wheel animation in progress. `pending` is reward the server announced but the
  // balance read has not shown yet: the last confirmed balance (`base`) and the rewards since.
  const [reveal, setReveal] = useState<{ id: string; coins: number } | null>(null);
  const [pending, setPending] = useState<{ base: number; total: number } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [result, setResult] = useState('');
  const [toast, setToast] = useState<{ text: string; tone: 'info' | 'danger' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  const revealed = useRef(new Set<string>());
  const inFlight = useRef(false);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  // Pending ends when a read shows the credit (and the wheel has stopped).
  const coinsRead = player?.coins;
  useEffect(() => {
    if (
      pending &&
      !reveal &&
      coinsRead !== undefined &&
      coinsRead >= pending.base + pending.total
    ) {
      setPending(null);
      setStalled(false);
    }
  }, [pending, reveal, coinsRead]);
  // While a credit is pending, re-read the balance on a bounded interval.
  const pendingTotal = pending?.total;
  useEffect(() => {
    if (pendingTotal === undefined) return;
    let reads = 0;
    const id = window.setInterval(() => {
      reads += 1;
      void qc.invalidateQueries({ queryKey: queryKeys.player.all });
      if (reads >= BALANCE_POLL_MAX) {
        window.clearInterval(id);
        setStalled(true);
      }
    }, BALANCE_POLL_MS);
    return () => window.clearInterval(id);
  }, [pendingTotal, qc]);
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
        <Stack gap={3} align="start">
          <Alert tone="danger">The wheel could not be loaded.</Alert>
          <Button variant="secondary" onClick={() => void refetch()}>
            Try again
          </Button>
        </Stack>
      </Card>
    );
  }

  const spinning = reveal !== null;
  // Never below the last confirmed balance while a reward is pending, and the prize stays hidden until
  // the wheel stops, even if a read already contains the credit.
  const credited = pending === null || player.coins >= pending.base + pending.total;
  const balance =
    pending === null || (credited && !spinning)
      ? player.coins
      : spinning
        ? pending.base
        : Math.max(player.coins, pending.base);
  const pendingCoins =
    pending && !spinning && !credited ? pending.base + pending.total - balance : 0;

  function finishReveal(id: string, coins: number) {
    if (revealed.current.has(id)) return;
    revealed.current.add(id);
    setReveal((r) => (r?.id === id ? null : r));
    setResult(`You won ${coins} coins`);
  }

  /**
   * A lost reply or a 5xx leaves the outcome unknown. Say so, then ask again: the adapter reuses the
   * same idempotency key, so the server answers with the stored spin instead of making a second one.
   */
  async function spinWithRecheck() {
    try {
      return await api.player.spin();
    } catch (first) {
      if (!isOutcomeUnknown(first)) throw first;
      setToast({ text: 'Result unknown — checking your spin.', tone: 'info' });
      let last: unknown = first;
      for (const wait of recheckDelaysMs) {
        await new Promise<void>((resolve) => later(resolve, wait));
        try {
          return await api.player.spin();
        } catch (e) {
          if (!isOutcomeUnknown(e)) throw e;
          last = e;
        }
      }
      throw last;
    }
  }

  function spinFailureText(e: unknown) {
    if (e instanceof MioApiError && e.code === 'no_spins') return 'No spins left.';
    if (isOutcomeUnknown(e))
      return 'Result unknown — we could not confirm your spin yet. It may have been used; check History before trying again.';
    return 'The spin was rejected. Reload the widget and try again.';
  }

  async function doSpin() {
    if (inFlight.current || spinning || !player || player.spins < 1) return;
    inFlight.current = true;
    setBusy(true);
    setResult('');
    try {
      const res = await spinWithRecheck(); // one idempotency key per action, kept across re-queries
      setToast(null);
      setStalled(false);
      setPending((p) => ({ base: p ? p.base : player.coins, total: (p?.total ?? 0) + res.coins }));
      setReveal({ id: res.id, coins: res.coins });
      await qc.invalidateQueries({ queryKey: queryKeys.player.all });
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      // Independent of the Wheel (a tab switch may unmount it): the reveal always ends.
      later(() => finishReveal(res.id, res.coins), reduce ? 150 : SPIN_MS + 300);
    } catch (e) {
      setToast({ text: spinFailureText(e), tone: 'danger' });
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
        r.granted === undefined
          ? 'Deposit of 40 EUR sent to the casino. Your spins appear here in a moment.'
          : r.granted > 0
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
    <ThemeScope>
      <Card
        aria-label="MIO Games widget"
        title="Daily Wheel"
        actions={
          <Stack row gap={2} align="center">
            <CoinBalance coins={balance} />
            {pendingCoins > 0 && (
              <Badge>
                {stalled ? `+${pendingCoins} pending (delayed)` : `+${pendingCoins} pending`}
              </Badge>
            )}
          </Stack>
        }
        description={spinsLabel}
      >
        {/* Always mounted, so the result is announced even when the Wheel tab is not showing. */}
        <LiveRegion data-testid="result-live">{result}</LiveRegion>

        <Stack gap={4}>
          <Tabs tabs={TABS} value={tab} onChange={setTab} label="Widget sections" idPrefix="pw" />
          <Toast message={toast?.text ?? ''} tone={toast?.tone} onDismiss={() => setToast(null)} />

          {tab === 'wheel' && (
            <TabPanel idPrefix="pw" id="wheel">
              <Stack gap={3}>
                <Wheel
                  segments={player.wheel}
                  spin={wheelSpin}
                  onSpinEnd={(id) =>
                    id === player.lastSpin?.id && finishReveal(id, player.lastSpin.coins)
                  }
                  size={300}
                />
                <Heading level={3} center reserve data-testid="result-text">
                  {spinning ? 'Spinning...' : result}
                </Heading>
                <Stack gap={2}>
                  <Button
                    size="lg"
                    onClick={() => void doSpin()}
                    loading={busy || spinning}
                    aria-disabled={player.spins < 1 || busy || spinning || undefined}
                  >
                    {player.spins < 1 ? 'No spins left' : 'Spin'}
                  </Button>
                  {player.spins < 1 && (
                    <Text tone="muted" center>
                      Spins come from deposits. Make a deposit to get more.
                    </Text>
                  )}
                  {demoControls && (
                    <Button
                      variant="secondary"
                      loading={deposit.isPending}
                      onClick={() => void doDeposit()}
                    >
                      Simulate a 40 EUR deposit at the casino
                    </Button>
                  )}
                </Stack>
              </Stack>
            </TabPanel>
          )}

          {tab === 'store' && (
            <TabPanel idPrefix="pw" id="store">
              <Stack gap={3}>
                {demoControls && (
                  <Checkbox
                    muted
                    label="Demo: make the casino fail the next reward (shows failed, then refunded)"
                    checked={player.casinoDown}
                    onChange={(e) => casinoDown.mutate(e.target.checked)}
                  />
                )}
                <Grid cols={2} gap={3}>
                  {player.store.map((it) => (
                    <StoreItemCard
                      key={it.id}
                      item={it}
                      balance={balance}
                      busy={busyItem === it.id}
                      onRedeem={(i) => void redeem(i.id)}
                    />
                  ))}
                </Grid>
                <Heading level={3}>Your redemptions</Heading>
                <ActivityList
                  bordered
                  empty="Nothing redeemed yet."
                  items={player.redemptions.map((r) => ({
                    id: r.id,
                    title: r.item,
                    trailing: (
                      <>
                        {r.status === 'failed_refunded' && (
                          <Badge>{`+${r.coins} coins back`}</Badge>
                        )}
                        <StatusPill status={r.status} />
                      </>
                    ),
                  }))}
                />
              </Stack>
            </TabPanel>
          )}

          {tab === 'history' && (
            <TabPanel idPrefix="pw" id="history">
              <ActivityList
                items={history.map((h) => ({
                  id: h.id,
                  title: h.what,
                  subtitle: h.at,
                  trailing: <SignedAmount value={h.delta} />,
                }))}
              />
            </TabPanel>
          )}
        </Stack>
      </Card>
    </ThemeScope>
  );
}
