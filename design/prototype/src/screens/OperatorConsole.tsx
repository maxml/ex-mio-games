import { useId, useState, type ReactNode } from 'react';
import { Badge, Button, Card, CoinIcon, Stepper, StatTile, StatusPill, Table, cn } from '../components';
import type { Status } from '../components';
import {
  INVOICE_LINES,
  PLANS,
  REDEMPTIONS,
  SANDBOX_STEPS,
  STORE_ITEMS,
  USAGE_DAYS,
  WHEEL_REWARDS,
  WHEEL_VERSIONS,
} from '../mock/data';

const STEPS = [
  { id: 'signup', label: 'Sign up' },
  { id: 'plan', label: 'Plan' },
  { id: 'keys', label: 'Keys' },
  { id: 'sandbox', label: 'Sandbox test' },
  { id: 'rules', label: 'Rules' },
  { id: 'wheel', label: 'Wheel' },
  { id: 'store', label: 'Store' },
  { id: 'redemptions', label: 'Redemptions' },
  { id: 'billing', label: 'Usage & invoice' },
];

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold">{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}
const INPUT = 'h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg';

export function OperatorScreen() {
  const [step, setStep] = useState(0);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="font-display text-2xl font-bold">Operator console</h1>
      <p className="mb-4 text-sm text-fg-muted">From signup to first invoice. Every step is clickable; data is mocked.</p>
      <Stepper steps={STEPS} current={step} onSelect={setStep} className="mb-6" />
      {step === 0 && <Signup onNext={() => setStep(1)} />}
      {step === 1 && <Plan onNext={() => setStep(2)} />}
      {step === 2 && <Keys onNext={() => setStep(3)} />}
      {step === 3 && <Sandbox onNext={() => setStep(4)} />}
      {step === 4 && <Rules />}
      {step === 5 && <WheelTable />}
      {step === 6 && <Store />}
      {step === 7 && <Redemptions />}
      {step === 8 && <Billing />}
    </div>
  );
}

function Signup({ onNext }: { onNext: () => void }) {
  const [done, setDone] = useState(false);
  const [email, setEmail] = useState('');
  const bad = email !== '' && !/^\S+@\S+\.\S+$/.test(email);
  return (
    <Card title="Create your operator account" description="No card needed to start. You get a sandbox straight away.">
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad && email) setDone(true);
        }}
      >
        <Field label="Company name">{(id) => <input id={id} className={INPUT} defaultValue="Cherry Row Ltd" />}</Field>
        <Field label="Work email" hint={bad ? undefined : 'We send the verification link here.'}>
          {(id) => (
            <>
              <input id={id} type="email" className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={bad} aria-describedby={bad ? `${id}-err` : undefined} />
              {bad && <p id={`${id}-err`} className="mt-1 text-xs text-danger">Enter an email like name@company.com</p>}
            </>
          )}
        </Field>
        <Field label="Password">{(id) => <input id={id} type="password" className={INPUT} defaultValue="correct horse" />}</Field>
        <Button type="submit">Create account</Button>
      </form>
      {done && (
        <p role="status" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-success">
          Account created (mock). <Button size="sm" onClick={onNext}>Choose a plan</Button>
        </p>
      )}
    </Card>
  );
}

function Plan({ onNext }: { onNext: () => void }) {
  const [plan, setPlan] = useState('growth');
  return (
    <Card title="Choose a plan" description="14-day trial on every plan. Change or cancel any time.">
      <div role="radiogroup" aria-label="Plan" className="grid gap-3 md:grid-cols-3">
        {PLANS.map((p) => (
          <label
            key={p.id}
            className={cn('cursor-pointer rounded-lg border p-4', plan === p.id ? 'border-primary bg-surface-2' : 'border-border bg-surface')}
          >
            <input type="radio" name="plan" className="sr-only" checked={plan === p.id} onChange={() => setPlan(p.id)} />
            <span className="flex items-center justify-between">
              <span className="font-display text-base font-semibold">{p.name}</span>
              {plan === p.id && <Badge tone="primary" icon>Selected</Badge>}
            </span>
            <span className="mt-2 block font-display text-2xl font-bold">{p.price} EUR<span className="text-sm font-normal text-fg-muted"> / month</span></span>
            <span className="mt-2 block text-sm">{p.spins}</span>
            <span className="block text-sm text-fg-muted">{p.extra}</span>
          </label>
        ))}
      </div>
      <p className="mt-4 text-sm text-fg-muted">Payment uses the fake provider in this prototype; a real card form arrives with the Stripe provider.</p>
      <Button className="mt-4" onClick={onNext}>Start trial</Button>
    </Card>
  );
}

function Keys({ onNext }: { onNext: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState('');
  const rows = [
    { label: 'Publishable key (widget)', value: 'pk_test_9d41c0a7e2b84f10' },
    { label: 'Secret key (server to server)', value: shown ? 'sk_test_EXAMPLE_0000000000' : 'sk_test_' + '•'.repeat(20) },
    { label: 'Webhook secret (verify casino events)', value: shown ? 'whsec_a83d0c1177ef42b9' : 'whsec_' + '•'.repeat(16) },
  ];
  return (
    <Card title="Integration keys" description="Test keys. Live keys unlock after the sandbox test passes.">
      <dl className="grid gap-4">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <dt className="text-sm font-semibold">{r.label}</dt>
              <dd className="font-mono text-sm text-fg-muted">{r.value}</dd>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setCopied(r.label)}>Copy</Button>
          </div>
        ))}
      </dl>
      <p role="status" className="mt-3 min-h-5 text-sm text-success">{copied && `Copied: ${copied} (mock, nothing is copied)`}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setShown((s) => !s)}>{shown ? 'Hide secrets' : 'Reveal secrets'}</Button>
        <Button variant="danger" onClick={() => setCopied('rotated: old secret works for 24 more hours')}>Rotate webhook secret</Button>
        <Button onClick={onNext}>Run sandbox test</Button>
      </div>
    </Card>
  );
}

function Sandbox({ onNext }: { onNext: () => void }) {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [shown, setShown] = useState(0);
  function run() {
    setState('running');
    setShown(0);
    SANDBOX_STEPS.forEach((_, i) =>
      window.setTimeout(() => {
        setShown(i + 1);
        if (i === SANDBOX_STEPS.length - 1) setState('done');
      }, 500 * (i + 1)),
    );
  }
  return (
    <Card
      title="Sandbox casino test"
      description="Our simulated casino sends a deposit, then checks that your integration behaves."
      actions={<Button onClick={run} loading={state === 'running'}>{state === 'idle' ? 'Run test' : 'Run again'}</Button>}
    >
      <ol className="grid gap-2" aria-live="polite">
        {SANDBOX_STEPS.slice(0, shown).map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <span><span className="font-semibold">{s.label}</span> <span className="text-fg-muted">{s.detail}</span></span>
            <StatusPill status="accepted" />
          </li>
        ))}
        {state === 'idle' && <li className="text-sm text-fg-muted">Not run yet.</li>}
      </ol>
      {state === 'done' && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-success" role="status">All 5 checks passed. Live keys are unlocked.</p>
          <Button onClick={onNext}>Set up rules</Button>
        </div>
      )}
    </Card>
  );
}

function Rules() {
  const [min, setMin] = useState(20);
  const [spins, setSpins] = useState(1);
  const [per, setPer] = useState(true);
  const [cap, setCap] = useState(10);
  const invalid = min < 1 || spins < 1;
  return (
    <Card title="Spin rules" description="When does a deposit earn spins?">
      <div className="grid max-w-md gap-4">
        <Field label="Minimum deposit (EUR)">{(id) => <input id={id} type="number" className={INPUT} value={min} min={1} onChange={(e) => setMin(+e.target.value)} />}</Field>
        <Field label="Spins granted">{(id) => <input id={id} type="number" className={INPUT} value={spins} min={1} onChange={(e) => setSpins(+e.target.value)} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={per} onChange={(e) => setPer(e.target.checked)} /> Repeat for every full multiple of the minimum</label>
        <Field label="Daily spin cap per player">{(id) => <input id={id} type="number" className={INPUT} value={cap} min={1} onChange={(e) => setCap(+e.target.value)} />}</Field>
      </div>
      <p className="mt-4 rounded-md bg-surface-2 p-3 text-sm" role="status">
        {invalid
          ? 'Values must be at least 1.'
          : `Preview: a 40 EUR deposit earns ${per ? Math.floor(40 / min) * spins : 40 >= min ? spins : 0} spin(s), at most ${cap} per player per day.`}
      </p>
      <Button className="mt-4" disabled={invalid}>Save rules</Button>
    </Card>
  );
}

function WheelTable() {
  const [weights, setWeights] = useState(WHEEL_REWARDS.map((r) => r.weight));
  const [versions, setVersions] = useState(WHEEL_VERSIONS);
  const total = weights.reduce((a, b) => a + b, 0);
  const ev = WHEEL_REWARDS.reduce((s, r, i) => s + (r.coins * weights[i]) / total, 0);
  const bad = weights.some((w) => !(w > 0));
  const next = versions[0].version + 1;
  return (
    <div className="grid gap-4">
      <Card
        title="Wheel reward table"
        description="Probabilities come from weights. Publishing creates a new version; spins already made keep the version they used."
        actions={<Badge tone="warning" icon>Draft on v{versions[0].version}</Badge>}
      >
        <Table
          caption="Wheel segments"
          rowKey={(r) => r.id}
          rows={WHEEL_REWARDS.map((r, i) => ({ ...r, i }))}
          columns={[
            { key: 'c', header: 'Reward', render: (r) => <span className="inline-flex items-center gap-1.5"><CoinIcon className="size-4" />{r.coins} coins</span> },
            {
              key: 'w',
              header: 'Weight',
              render: (r) => (
                <input
                  aria-label={`Weight for ${r.coins} coins`}
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={weights[r.i]}
                  onChange={(e) => setWeights((w) => w.map((x, j) => (j === r.i ? +e.target.value : x)))}
                  className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-right text-sm"
                />
              ),
              align: 'right',
            },
            { key: 'p', header: 'Probability', render: (r) => `${((weights[r.i] / total) * 100).toFixed(1)}%`, align: 'right' },
          ]}
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatTile label="Expected payout per spin" value={`${ev.toFixed(1)} coins`} />
          <StatTile label="Total weight" value={total.toFixed(1)} />
          <StatTile label="Top prize odds" value={`1 in ${Math.round(total / weights[6])}`} />
        </div>
        {bad && <p className="mt-3 text-sm text-danger" role="alert">Every weight must be greater than 0.</p>}
        <Button
          className="mt-4"
          disabled={bad}
          onClick={() => setVersions((v) => [{ version: next, state: 'published', publishedAt: '2026-11-21', note: `Expected payout ${ev.toFixed(1)} coins per spin` }, ...v.map((x) => ({ ...x, state: 'archived' as Status }))])}
        >
          Publish as v{next}
        </Button>
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
    </div>
  );
}

function Store() {
  const [items, setItems] = useState(STORE_ITEMS.map((i) => ({ ...i, on: true })));
  return (
    <Card title="Bonus Store catalog" description="What players can buy with coins, and how each reward is issued at your casino." flush>
      <Table
        caption="Store catalog"
        rowKey={(i) => i.id}
        rows={items}
        columns={[
          { key: 'n', header: 'Item', render: (i) => <span><span className="font-semibold">{i.name}</span><span className="block text-xs text-fg-muted">{i.description}</span></span> },
          {
            key: 'p',
            header: 'Price (coins)',
            align: 'right',
            render: (i) => (
              <input
                aria-label={`Price of ${i.name}`}
                type="number"
                min={1}
                value={i.priceCoins}
                onChange={(e) => setItems((l) => l.map((x) => (x.id === i.id ? { ...x, priceCoins: +e.target.value } : x)))}
                className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-right text-sm"
              />
            ),
          },
          { key: 's', header: 'Stock', align: 'right', render: (i) => (i.stock === undefined ? 'Unlimited' : i.stock), hideOnMobile: true },
          {
            key: 'a',
            header: 'Visible',
            render: (i) => (
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={i.on} onChange={() => setItems((l) => l.map((x) => (x.id === i.id ? { ...x, on: !x.on } : x)))} />
                <span className="sr-only">Visible to players: {i.name}</span>
                <StatusPill status={i.on ? 'published' : 'draft'} />
              </label>
            ),
          },
        ]}
      />
    </Card>
  );
}

function Redemptions() {
  const [filter, setFilter] = useState<'all' | Status>('all');
  const rows = REDEMPTIONS.filter((r) => filter === 'all' || r.status === filter);
  const filters: ('all' | Status)[] = ['all', 'pending', 'issuing', 'issued', 'failed', 'refunded'];
  return (
    <Card title="Redemptions" description="Each redemption is a promise to the player. Failed ones are refunded in coins automatically." flush>
      <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3" role="group" aria-label="Filter by status">
        {filters.map((f) => (
          <Button key={f} size="sm" variant={filter === f ? 'primary' : 'secondary'} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f[0].toUpperCase() + f.slice(1)}
          </Button>
        ))}
      </div>
      <Table
        caption="Redemptions"
        rowKey={(r) => r.id}
        rows={rows}
        empty="No redemptions with this status."
        columns={[
          { key: 'id', header: 'Id', render: (r) => r.id, hideOnMobile: true },
          { key: 'p', header: 'Player', render: (r) => r.player },
          { key: 'i', header: 'Item', render: (r) => <span>{r.item}{r.note && <span className="block text-xs text-fg-muted">{r.note}</span>}</span> },
          { key: 'c', header: 'Coins', align: 'right', render: (r) => r.coins, hideOnMobile: true },
          { key: 's', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
          { key: 't', header: 'When', render: (r) => r.at, hideOnMobile: true },
        ]}
      />
    </Card>
  );
}

function Billing() {
  const max = Math.max(...USAGE_DAYS);
  const used = 98200;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Spins this month" value={used.toLocaleString('en-US')} hint="of 150,000 included" delta={12.4} />
        <StatTile label="Active players" value="4,120" delta={6.1} />
        <StatTile label="Next invoice" value="799 EUR" hint="due 30 Nov" />
      </div>
      <Card title="Spins per day (last 14 days, thousands)">
        <div className="flex h-32 items-end gap-1" role="img" aria-label={`Daily spins, thousands: ${USAGE_DAYS.join(', ')}`}>
          {USAGE_DAYS.map((v, i) => (
            <div key={i} className="flex-1 rounded-t-sm bg-primary" style={{ height: `${(v / max) * 100}%` }} />
          ))}
        </div>
      </Card>
      <Card title="Invoice, November 2026" actions={<StatusPill status="open" />} flush>
        <Table
          caption="Invoice lines"
          rowKey={(l) => l.id}
          rows={INVOICE_LINES}
          columns={[
            { key: 'i', header: 'Item', render: (l) => l.item },
            { key: 'q', header: 'Qty', align: 'right', render: (l) => l.qty, hideOnMobile: true },
            { key: 'a', header: 'Amount (EUR)', align: 'right', render: (l) => l.amount.toFixed(2) },
          ]}
        />
        <p className="flex justify-between border-t border-border px-4 py-3 text-sm font-semibold"><span>Total</span><span className="tabular-nums">799.00 EUR</span></p>
      </Card>
    </div>
  );
}
