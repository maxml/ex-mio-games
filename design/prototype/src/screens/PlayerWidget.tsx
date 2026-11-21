import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CoinBalance, StatusPill, StoreItemCard, TabPanel, Tabs, Toast, Wheel, cn } from '../components';
import type { StoreItem } from '../components';
import { WHEEL_REWARDS } from '../mock/data';
import { appStore, requestSpin, simulateDeposit, startRedeem, useApp } from '../state/store';
import { themeStyle, useTheme } from '../theme/theme';

type Tab = 'wheel' | 'store' | 'history';
const TABS: { id: Tab; label: string }[] = [
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Bonus Store' },
  { id: 'history', label: 'History' },
];
const SPIN_MS = 4200;

export function PlayerScreen() {
  const { theme } = useTheme();
  const [phone, setPhone] = useState(false);
  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-bg">
      {/* Casino page mock: the widget is embedded in someone else's site. */}
      <div className="border-b border-border bg-surface-2">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="font-display text-lg font-bold">{theme.name} <span className="text-sm font-normal text-fg-muted">(casino page mock)</span></p>
          <nav aria-label="Casino mock" className="flex gap-4 text-sm text-fg-muted">
            <span>Slots</span>
            <span>Live</span>
            <span>Promotions</span>
          </nav>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={phone} onChange={(e) => setPhone(e.target.checked)} />
            Phone width (375 px)
          </label>
        </div>
      </div>
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className={cn('mx-auto', phone ? 'max-w-[375px] rounded-lg border border-border p-2' : 'max-w-xl')}>
          <PlayerWidget />
        </div>
      </div>
    </div>
  );
}

function PlayerWidget() {
  const { theme } = useTheme();
  const player = useApp((s) => s.player);
  const catalog = useApp((s) => s.operator.catalog);
  const [tab, setTab] = useState<Tab>('wheel');
  // The result was credited in the store when the server answered. These two only hold the
  // presentation: the part of the balance still "in the air" and the text announced afterwards.
  const [reveal, setReveal] = useState<{ id: string; coins: number } | null>(null);
  const [result, setResult] = useState('');
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const timers = useRef<number[]>([]);
  const revealed = useRef(new Set<string>());
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const spinning = reveal !== null;
  const balance = player.coins - (reveal?.coins ?? 0);

  function finishReveal(id: string, coins: number) {
    if (revealed.current.has(id)) return;
    revealed.current.add(id);
    setReveal((r) => (r?.id === id ? null : r));
    setResult(`You won ${coins} coins`);
  }

  function doSpin() {
    if (spinning || player.spins < 1) return;
    const res = requestSpin(); // credits once, inside the store
    if (!res) return;
    setResult('');
    setReveal({ id: res.id, coins: res.coins });
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    // Independent of the Wheel (which may be unmounted by a tab switch): the reveal always ends.
    later(() => finishReveal(res.id, res.coins), reduce ? 150 : SPIN_MS + 300);
  }
  function deposit() {
    const granted = simulateDeposit();
    setToast(
      granted > 0
        ? `Deposit of 40 EUR confirmed by the casino: ${granted} ${granted === 1 ? 'spin' : 'spins'} added.`
        : 'Deposit of 40 EUR confirmed, but it earns no spins under the casino rules (minimum deposit or daily cap).',
    );
  }
  function redeem(item: StoreItem) {
    if (busyItem) return;
    if (startRedeem(item.id)) {
      setBusyItem(item.id);
      later(() => setBusyItem(null), 600);
    }
  }

  const items = catalog.filter((i) => i.visible);
  const history = player.history.filter((h) => !reveal || h.spinId !== reveal.id);
  const spinsLabel = `${player.spins} ${player.spins === 1 ? 'spin' : 'spins'} available`;

  return (
    <div style={themeStyle(theme)} className="text-fg">
      <Card aria-label="MIO Games widget" title="Daily Wheel" actions={<CoinBalance coins={balance} />} description={spinsLabel}>
        {/* Always mounted, so the result is announced even when the Wheel tab is not showing. */}
        <div className="sr-only" role="status" aria-live="polite" data-testid="result-live">{result}</div>

        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Widget sections" idPrefix="pw" className="mb-4" />
        <Toast message={toast} onDismiss={() => setToast('')} className="mb-3 empty:hidden" />

        {tab === 'wheel' && (
          <TabPanel idPrefix="pw" id="wheel">
            <Wheel
              segments={WHEEL_REWARDS}
              spin={player.lastSpin}
              onSpinEnd={(id) => id === player.lastSpin?.id && finishReveal(id, player.lastSpin.coins)}
              size={300}
            />
            <p className="mt-3 min-h-7 text-center font-display text-lg font-bold" data-testid="result-text">
              {spinning ? 'Spinning...' : result}
            </p>
            <div className="mt-2 flex flex-col gap-2">
              <Button size="lg" onClick={doSpin} loading={spinning} aria-disabled={player.spins < 1 || spinning || undefined}>
                {player.spins < 1 ? 'No spins left' : 'Spin'}
              </Button>
              {player.spins < 1 && (
                <p className="text-center text-sm text-fg-muted">Spins come from deposits. Make a deposit to get more.</p>
              )}
              <Button variant="secondary" onClick={deposit}>Simulate a 40 EUR deposit at the casino</Button>
            </div>
          </TabPanel>
        )}

        {tab === 'store' && (
          <TabPanel idPrefix="pw" id="store">
            <label className="mb-3 flex items-center gap-2 text-sm text-fg-muted">
              <input type="checkbox" checked={player.casinoDown} onChange={(e) => appStore.dispatch({ type: 'player/casinoDown', on: e.target.checked })} />
              Demo: make the casino fail the next reward (shows failed, then refunded)
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {items.map((it) => (
                <StoreItemCard key={it.id} item={it} balance={balance} busy={busyItem === it.id} onRedeem={redeem} />
              ))}
            </div>
            <h3 className="mb-2 mt-5 font-display text-base font-semibold">Your redemptions</h3>
            {player.redemptions.length === 0 ? (
              <p className="text-sm text-fg-muted">Nothing redeemed yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {player.redemptions.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span>{r.item}</span>
                    <span className="flex items-center gap-2">
                      {r.status === 'refunded' && <Badge>{`+${r.coins} coins back`}</Badge>}
                      <StatusPill status={r.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TabPanel>
        )}

        {tab === 'history' && (
          <TabPanel idPrefix="pw" id="history">
            <ul className="divide-y divide-border">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span>
                    <span className="block">{h.what}</span>
                    <span className="text-xs text-fg-muted">{h.at}</span>
                  </span>
                  <span className={cn('font-semibold tabular-nums', h.delta > 0 && 'text-success', h.delta < 0 && 'text-fg-muted')}>
                    {h.delta > 0 ? `+${h.delta}` : h.delta < 0 ? `${h.delta}` : 'spins'}
                  </span>
                </li>
              ))}
            </ul>
          </TabPanel>
        )}
      </Card>
    </div>
  );
}
