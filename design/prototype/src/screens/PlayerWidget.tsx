import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CoinBalance, StatusPill, StoreItemCard, Wheel, cn } from '../components';
import type { Status, StoreItem, WheelSpin } from '../components';
import { PLAYER_HISTORY, STORE_ITEMS, WHEEL_REWARDS } from '../mock/data';
import { useTheme } from '../theme/theme';

type Tab = 'wheel' | 'store' | 'history';
interface MyRedemption {
  id: string;
  item: string;
  coins: number;
  status: Status;
}
interface HistoryRow {
  id: string;
  at: string;
  what: string;
  delta: number;
}

/** Stand-in for the server: picks by weight. The wheel component only animates to the result. */
function pickReward(): number {
  const total = WHEEL_REWARDS.reduce((s, r) => s + r.weight, 0);
  let x = Math.random() * total;
  for (let i = 0; i < WHEEL_REWARDS.length; i++) {
    x -= WHEEL_REWARDS[i].weight;
    if (x < 0) return i;
  }
  return 0;
}

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
  const [tab, setTab] = useState<Tab>('wheel');
  const [spins, setSpins] = useState(3);
  const [coins, setCoins] = useState(420);
  const [spin, setSpin] = useState<WheelSpin | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<string>('');
  const [reds, setReds] = useState<MyRedemption[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>(PLAYER_HISTORY);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [casinoDown, setCasinoDown] = useState(false);
  const [toast, setToast] = useState('');
  const nonce = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  const log = (what: string, delta: number) =>
    setHistory((h) => [{ id: `n${Date.now()}${Math.random()}`, at: 'Just now', what, delta }, ...h]);

  function doSpin() {
    if (spinning || spins < 1) return;
    setSpinning(true);
    setSpins((s) => s - 1);
    setResult('');
    nonce.current += 1;
    setSpin({ index: pickReward(), nonce: nonce.current });
  }
  function onSpinEnd(index: number) {
    const r = WHEEL_REWARDS[index];
    setSpinning(false);
    setCoins((c) => c + r.coins);
    setResult(`You won ${r.coins} coins`);
    log(`Spin: landed on ${r.coins}`, r.coins);
  }
  function deposit() {
    setSpins((s) => s + 2);
    setToast('Deposit of 40 EUR confirmed by the casino: 2 spins added.');
    log('Deposit 40 EUR earned 2 spins', 0);
  }
  function redeem(item: StoreItem) {
    if (busyItem || coins < item.priceCoins) return;
    setBusyItem(item.id);
    setCoins((c) => c - item.priceCoins); // coins are held at once; refunded if issuing fails
    const id = `rd-${Date.now()}`;
    setReds((r) => [{ id, item: item.name, coins: item.priceCoins, status: 'pending' }, ...r]);
    log(`Redeemed ${item.name}`, -item.priceCoins);
    const set = (status: Status) => setReds((r) => r.map((x) => (x.id === id ? { ...x, status } : x)));
    later(() => setBusyItem(null), 600);
    later(() => set('issuing'), 1200);
    later(() => {
      if (casinoDown) {
        set('failed');
        later(() => {
          set('refunded');
          setCoins((c) => c + item.priceCoins);
          log(`Refund: ${item.name} could not be issued`, item.priceCoins);
        }, 1400);
      } else set('issued');
    }, 2600);
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'wheel', label: 'Wheel' },
    { id: 'store', label: 'Bonus Store' },
    { id: 'history', label: 'History' },
  ];

  return (
    <Card
      aria-label="MIO Games widget"
      title="Daily Wheel"
      actions={<CoinBalance coins={coins} />}
      description={`${spins} ${spins === 1 ? 'spin' : 'spins'} available`}
    >
      <div role="tablist" aria-label="Widget sections" className="mb-4 flex gap-1 rounded-md bg-surface-2 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = tabs.findIndex((x) => x.id === tab);
              if (e.key === 'ArrowRight') setTab(tabs[(i + 1) % tabs.length].id);
              if (e.key === 'ArrowLeft') setTab(tabs[(i + tabs.length - 1) % tabs.length].id);
            }}
            className={cn(
              'flex-1 rounded-sm px-2 py-2 text-sm font-semibold',
              tab === t.id ? 'bg-surface text-fg shadow-card' : 'text-fg-muted hover:text-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {toast && (
        <p role="status" className="mb-3 flex items-start justify-between gap-2 rounded-md border border-info bg-surface px-3 py-2 text-sm text-info">
          <span>{toast}</span>
          <button className="font-semibold underline" onClick={() => setToast('')}>Dismiss</button>
        </p>
      )}

      {tab === 'wheel' && (
        <div role="tabpanel" id="panel-wheel" aria-labelledby="tab-wheel">
          <Wheel segments={WHEEL_REWARDS} spin={spin} onSpinEnd={onSpinEnd} size={300} />
          <p className="mt-3 min-h-6 text-center font-display text-lg font-bold" role="status" aria-live="polite">
            {spinning ? 'Spinning...' : result}
          </p>
          <div className="mt-2 flex flex-col gap-2">
            <Button size="lg" onClick={doSpin} loading={spinning} disabled={spins < 1}>
              {spins < 1 ? 'No spins left' : 'Spin'}
            </Button>
            {spins < 1 && (
              <p className="text-center text-sm text-fg-muted">Spins come from deposits. Make a deposit to get more.</p>
            )}
            <Button variant="secondary" onClick={deposit}>Simulate a 40 EUR deposit at the casino</Button>
          </div>
        </div>
      )}

      {tab === 'store' && (
        <div role="tabpanel" id="panel-store" aria-labelledby="tab-store">
          <label className="mb-3 flex items-center gap-2 text-sm text-fg-muted">
            <input type="checkbox" checked={casinoDown} onChange={(e) => setCasinoDown(e.target.checked)} />
            Demo: make the casino fail the next reward (shows failed, then refunded)
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            {STORE_ITEMS.map((it) => (
              <StoreItemCard key={it.id} item={it} balance={coins} busy={busyItem === it.id} onRedeem={redeem} />
            ))}
          </div>
          <h3 className="mb-2 mt-5 font-display text-base font-semibold">Your redemptions</h3>
          {reds.length === 0 ? (
            <p className="text-sm text-fg-muted">Nothing redeemed yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {reds.map((r) => (
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
        </div>
      )}

      {tab === 'history' && (
        <div role="tabpanel" id="panel-history" aria-labelledby="tab-history">
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
        </div>
      )}
    </Card>
  );
}
