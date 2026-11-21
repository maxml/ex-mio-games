import { useRef, useState } from 'react';
import { Alert, Badge, Button, Card, CoinIcon, Field, Input, Stepper, StatTile, StatusPill, Table, Toast, cn } from '../components';
import type { Status } from '../components';
import { PLANS, REDEMPTIONS, SANDBOX_STEPS, USAGE_DAYS, WHEEL_REWARDS, expectedPayout, type Redemption } from '../mock/data';
import { DEFAULT_RULES, STEPS, TOP_PRIZE_INDEX, rulesValid, sameWeights, spinsForDeposit, weightsValid, type CatalogItem, type Rules } from '../state/reducer';
import { appStore, useApp } from '../state/store';
import { Checkout } from './operator/Checkout';
import { StepNav } from './operator/StepNav';

export function OperatorScreen() {
  const step = useApp((s) => s.operator.step);
  const done = useApp((s) => s.operator.done);
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="font-display text-2xl font-bold">Operator console</h1>
      <p className="mb-4 text-sm text-fg-muted">
        From signup to a paid, live integration. Each step has Back and Continue; the step bar ticks only what is really done. Data is mocked and shared with the player widget.
      </p>
      <Stepper
        steps={STEPS.map((s) => ({ ...s, done: done[s.id] }))}
        current={step}
        onSelect={(i) => appStore.dispatch({ type: 'step/set', step: i })}
        className="mb-6"
      />
      {step === 0 && <Signup />}
      {step === 1 && <Plan />}
      {step === 2 && <Keys />}
      {step === 3 && <Sandbox />}
      {step === 4 && <GoLive />}
      {step === 5 && <RulesStep />}
      {step === 6 && <WheelTable />}
      {step === 7 && <Store />}
      {step === 8 && <Redemptions />}
      {step === 9 && <Billing />}
    </div>
  );
}

function Signup() {
  const created = useApp((s) => s.operator.accountCreated);
  const [email, setEmail] = useState('');
  const bad = email !== '' && !/^\S+@\S+\.\S+$/.test(email);
  return (
    <Card title="Create your operator account" description="No card needed to start. You get a sandbox straight away.">
      <form
        className="grid max-w-md gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad && email) appStore.dispatch({ type: 'account/create' });
        }}
      >
        <Field label="Company name">{({ id }) => <Input id={id} defaultValue="Cherry Row Ltd" />}</Field>
        <Field label="Work email" hint="We send the verification link here." error={bad ? 'Enter an email like name@company.com' : undefined}>
          {({ id, invalid, describedBy }) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} invalid={invalid} aria-describedby={describedBy} />}
        </Field>
        <Field label="Password">{({ id }) => <Input id={id} type="password" defaultValue="correct horse" />}</Field>
        <Button type="submit" disabled={created}>{created ? 'Account created' : 'Create account'}</Button>
      </form>
      {created && <Alert tone="success" className="mt-4">Account created (mock). A sandbox is ready for you.</Alert>}
      <StepNav index={0} canContinue={created} hint="Create the account to continue." />
    </Card>
  );
}

function Plan() {
  const { plan, planActive, cardLast4, paidPlan, paidAmount, payment } = useApp((s) => s.operator);
  const [paying, setPaying] = useState(false);
  const chosen = PLANS.find((p) => p.id === plan) ?? PLANS[1];
  const processing = payment?.status === 'processing';

  if (planActive) {
    // What was charged, not what is selected now.
    const paid = PLANS.find((p) => p.id === paidPlan) ?? chosen;
    return (
      <Card title="Plan active" description="Payment received through the fake provider (test mode).">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <StatusPill status="active" />
          <span className="font-semibold">{paid.name}</span> at {paidAmount ?? paid.price} EUR / month, paid with the test card ending {cardLast4}.
        </p>
        <StepNav index={1} />
      </Card>
    );
  }
  if (paying || processing) {
    return (
      <div className="grid gap-4">
        <Checkout
          plan={chosen.id}
          amount={chosen.price}
          description={`${chosen.name} plan, first month`}
          onCancel={() => setPaying(false)}
        />
      </div>
    );
  }
  return (
    <Card title="Choose a plan" description="Billed monthly. Pay now to activate it; cancel any time.">
      <div role="radiogroup" aria-label="Plan" className="grid gap-3 md:grid-cols-3">
        {PLANS.map((p) => (
          <label
            key={p.id}
            className={cn(
              'cursor-pointer rounded-lg border p-4',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              plan === p.id ? 'border-primary bg-surface-2' : 'border-input-border bg-surface',
            )}
          >
            <input type="radio" name="plan" className="sr-only" checked={plan === p.id} onChange={() => appStore.dispatch({ type: 'plan/select', id: p.id })} />
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
      <p className="mt-4 text-sm text-fg-muted">Payment uses the fake provider in test mode; a real card form arrives with the Stripe provider.</p>
      <Button className="mt-4" onClick={() => setPaying(true)}>Choose plan and pay</Button>
      <StepNav index={1} canContinue={planActive} hint="Pay for a plan to continue." />
    </Card>
  );
}

function Keys() {
  const [shown, setShown] = useState(false);
  const [note, setNote] = useState('');
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
            <div className="min-w-0">
              <dt className="text-sm font-semibold">{r.label}</dt>
              <dd className="break-all font-mono text-sm text-fg-muted">{r.value}</dd>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setNote(`Copied: ${r.label} (mock, nothing is copied)`)}>Copy</Button>
          </div>
        ))}
      </dl>
      <Toast className="mt-3 empty:hidden" message={note} onDismiss={() => setNote('')} tone="success" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setShown((s) => !s)}>{shown ? 'Hide secrets' : 'Reveal secrets'}</Button>
        <Button variant="danger" onClick={() => setNote('Webhook secret rotated: the old secret works for 24 more hours.')}>Rotate webhook secret</Button>
      </div>
      <StepNav index={2} />
    </Card>
  );
}

function Sandbox() {
  const passed = useApp((s) => s.operator.sandboxPassed);
  const [state, setState] = useState<'idle' | 'running' | 'done'>(passed ? 'done' : 'idle');
  const [shown, setShown] = useState(passed ? SANDBOX_STEPS.length : 0);
  const run = useRef(0);
  function start() {
    const mine = ++run.current;
    setState('running');
    setShown(0);
    SANDBOX_STEPS.forEach((_, i) =>
      window.setTimeout(() => {
        if (run.current !== mine) return;
        setShown(i + 1);
        if (i === SANDBOX_STEPS.length - 1) {
          setState('done');
          appStore.dispatch({ type: 'sandbox/pass' });
        }
      }, 500 * (i + 1)),
    );
  }
  return (
    <Card
      title="Sandbox casino test"
      description="Our simulated casino sends a deposit, then checks that your integration behaves."
      actions={<Button onClick={start} loading={state === 'running'}>{state === 'idle' ? 'Run test' : 'Run again'}</Button>}
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
      {state === 'done' && <p className="mt-4 text-sm font-semibold text-success" role="status">All 5 checks passed. Live keys are unlocked.</p>}
      <StepNav index={3} canContinue={passed} hint="Run the sandbox test and pass all checks to continue." />
    </Card>
  );
}

function GoLive() {
  const { accountCreated, planActive, sandboxPassed, live } = useApp((s) => s.operator);
  const missing = [
    !accountCreated && { label: 'Create your account', step: 0 },
    !planActive && { label: 'Pay for a plan', step: 1 },
    !sandboxPassed && { label: 'Pass the sandbox test', step: 3 },
  ].filter((m): m is { label: string; step: number } => m !== false);
  return (
    <Card title="Go live" description="Switch from test keys to live keys and wait for the first real deposit from your casino.">
      {missing.length > 0 && live === 'off' ? (
        <Alert tone="warning">
          Live keys stay locked until an account exists, a plan is paid and the sandbox test passes. Still missing:
          <ul className="mt-1 list-disc pl-5">
            {missing.map((m) => (
              <li key={m.step}>
                <button type="button" className="font-semibold underline" onClick={() => appStore.dispatch({ type: 'step/set', step: m.step })}>{m.label}</button>
              </li>
            ))}
          </ul>
        </Alert>
      ) : (
        <div className="grid gap-4">
          <dl className="grid gap-3">
            <div>
              <dt className="text-sm font-semibold">Publishable key (widget)</dt>
              <dd className="break-all font-mono text-sm text-fg-muted">pk_live_EXAMPLE_00000000</dd>
            </div>
            <div>
              <dt className="text-sm font-semibold">Secret key (server to server)</dt>
              <dd className="break-all font-mono text-sm text-fg-muted">{live === 'off' ? 'Shown after you switch to live' : 'sk_live_EXAMPLE_0000000000'}</dd>
            </div>
          </dl>
          {live === 'off' && (
            <div>
              <Button onClick={() => appStore.dispatch({ type: 'live/start' })}>Switch to live keys</Button>
            </div>
          )}
          {live === 'awaiting' && (
            <div className="grid gap-3">
              <Alert tone="info"><span role="status">Live keys are on. Waiting for the first live deposit event from your casino.</span></Alert>
              <div>
                <Button variant="secondary" onClick={() => appStore.dispatch({ type: 'live/deposit' })}>Simulate the first live deposit (mock casino)</Button>
              </div>
            </div>
          )}
          {live === 'live' && (
            <Alert tone="success">
              <span role="status">
                <strong>You are live.</strong> First live deposit received: 40 EUR, spins granted under your rules. Players now see the widget.{' '}
                <a className="font-semibold underline" href="#/player">Open the player widget</a>
              </span>
            </Alert>
          )}
        </div>
      )}
      <StepNav index={4} canContinue={live === 'live'} hint="Switch to live keys and wait for the first live deposit to continue." />
    </Card>
  );
}

function RulesStep() {
  const saved = useApp((s) => s.operator.rules);
  const rulesSaved = useApp((s) => s.operator.rulesSaved);
  const [draft, setDraft] = useState<Rules>(saved);
  const set = (p: Partial<Rules>) => setDraft((d) => ({ ...d, ...p }));
  const invalid = !rulesValid(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const n = (v: string) => (v === '' ? NaN : +v);
  return (
    <Card title="Spin rules" description="When does a deposit earn spins?" actions={rulesSaved && !dirty ? <StatusPill status="published" /> : dirty ? <Badge tone="warning" icon>Unsaved changes</Badge> : null}>
      <div className="grid max-w-md gap-4">
        <Field label="Minimum deposit (EUR)">{({ id }) => <Input id={id} type="number" value={Number.isNaN(draft.min) ? '' : draft.min} min={1} onChange={(e) => set({ min: n(e.target.value) })} />}</Field>
        <Field label="Spins granted">{({ id }) => <Input id={id} type="number" value={Number.isNaN(draft.spins) ? '' : draft.spins} min={1} onChange={(e) => set({ spins: n(e.target.value) })} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.per} onChange={(e) => set({ per: e.target.checked })} /> Repeat for every full multiple of the minimum</label>
        <Field label="Daily spin cap per player">{({ id }) => <Input id={id} type="number" value={Number.isNaN(draft.cap) ? '' : draft.cap} min={1} onChange={(e) => set({ cap: n(e.target.value) })} />}</Field>
      </div>
      <p className="mt-4 rounded-md bg-surface-2 p-3 text-sm" role="status">
        {invalid
          ? 'Values must be whole numbers, at least 1.'
          : `Preview: a 40 EUR deposit earns ${Math.min(spinsForDeposit(draft, 40), draft.cap)} spin(s), at most ${draft.cap} per player per day.`}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button disabled={invalid || (!dirty && rulesSaved)} onClick={() => appStore.dispatch({ type: 'rules/save', rules: draft })}>Save rules</Button>
        <Button variant="secondary" onClick={() => setDraft({ ...DEFAULT_RULES })}>Reset to defaults</Button>
        {rulesSaved && !dirty && (
          <span className="text-sm text-success" role="status">
            Rules saved. The player widget uses them now; try the deposit button there (<a className="font-semibold underline" href="#/player">open</a>).
          </span>
        )}
      </div>
      <StepNav index={5} canContinue={rulesSaved && !dirty} hint="Save the rules to continue." />
    </Card>
  );
}

function WheelTable() {
  const { weights: published, version, versions } = useApp((s) => s.operator.wheel);
  const [draft, setDraft] = useState<number[]>(published);
  const total = draft.reduce((a, b) => a + b, 0);
  const ev = expectedPayout(draft);
  const bad = !weightsValid(draft);
  const dirty = !sameWeights(draft, published);
  const topW = draft[TOP_PRIZE_INDEX];
  const next = version + 1;
  return (
    <div className="grid gap-4">
      <Card
        title="Wheel reward table"
        description="Probabilities come from weights. Publishing creates a new version that the player widget uses for the next spin; spins already made keep the version they used."
        actions={dirty ? <Badge tone="warning" icon>Draft changes on v{version}</Badge> : <Badge tone="success" icon>v{version} published</Badge>}
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
                <Input
                  size="sm"
                  className="w-24 text-right"
                  aria-label={`Weight for ${r.coins} coins`}
                  type="number"
                  min={0.1}
                  step={0.5}
                  value={draft[r.i]}
                  invalid={!(draft[r.i] > 0)}
                  onChange={(e) => setDraft((w) => w.map((x, j) => (j === r.i ? +e.target.value : x)))}
                />
              ),
              align: 'right',
            },
            { key: 'p', header: 'Probability', render: (r) => (total > 0 ? `${((draft[r.i] / total) * 100).toFixed(1)}%` : 'n/a'), align: 'right' },
          ]}
        />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatTile label="Expected payout per spin" value={`${ev.toFixed(1)} coins`} />
          <StatTile label="Total weight" value={total.toFixed(1)} />
          <StatTile label="Top prize odds" value={topW > 0 && total > 0 ? `1 in ${Math.round(total / topW).toLocaleString('en-US')}` : 'n/a'} />
        </div>
        {bad && <p className="mt-3 text-sm text-danger" role="alert">Every weight must be greater than 0.</p>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button disabled={bad || !dirty} onClick={() => appStore.dispatch({ type: 'wheel/publish', weights: draft })}>Publish as v{next}</Button>
          {dirty && <Button variant="secondary" onClick={() => setDraft(published)}>Discard changes</Button>}
          {!dirty && <span className="text-sm text-fg-muted">Change a weight to publish a new version. <a className="font-semibold underline" href="#/player">Open the player widget</a> to spin on v{version}.</span>}
        </div>
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
      <StepNav index={6} canContinue={!dirty} hint="Publish or discard the draft to continue." />
    </div>
  );
}

function PriceInput({ item }: { item: CatalogItem }) {
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
          if (e.target.value.trim() !== '' && Number.isInteger(v) && v >= 1) appStore.dispatch({ type: 'catalog/price', id: item.id, price: v });
        }}
      />
      {!ok && <span role="alert" className="mt-1 text-xs text-danger">Whole number, at least 1</span>}
    </span>
  );
}

function Store() {
  const items = useApp((s) => s.operator.catalog);
  return (
    <div className="grid gap-4">
      <Card title="Bonus Store catalog" description="What players can buy with coins. Price and visibility changes show in the player widget at once." flush>
        <Table
          caption="Store catalog"
          rowKey={(i) => i.id}
          rows={items}
          columns={[
            { key: 'n', header: 'Item', render: (i) => <span><span className="font-semibold">{i.name}</span><span className="block text-xs text-fg-muted">{i.description}</span></span> },
            { key: 'p', header: 'Price (coins)', align: 'right', render: (i) => <PriceInput item={i} /> },
            { key: 's', header: 'Stock', align: 'right', render: (i) => (i.stock === undefined ? 'Unlimited' : i.stock), hideOnMobile: true },
            {
              key: 'a',
              header: 'Visible',
              render: (i) => (
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={i.visible} onChange={() => appStore.dispatch({ type: 'catalog/visible', id: i.id, on: !i.visible })} />
                  <span className="sr-only">Visible to players: {i.name}</span>
                  <StatusPill status={i.visible ? 'published' : 'draft'} />
                </label>
              ),
            },
          ]}
        />
      </Card>
      <StepNav index={7} />
    </div>
  );
}

function Redemptions() {
  const mine = useApp((s) => s.player.redemptions);
  const [filter, setFilter] = useState<'all' | Status>('all');
  const all: Redemption[] = [
    ...mine.map((r) => ({ id: r.id, player: 'p_you (demo)', item: r.item, coins: r.coins, status: r.status, at: 'Just now' })),
    ...REDEMPTIONS,
  ];
  const rows = all.filter((r) => filter === 'all' || r.status === filter);
  const filters: ('all' | Status)[] = ['all', 'pending', 'issuing', 'issued', 'failed', 'refunded'];
  return (
    <div className="grid gap-4">
      <Card title="Redemptions" description="Each redemption is a promise to the player. Failed ones are refunded in coins automatically. Redemptions made in the player widget appear first." flush>
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
      <StepNav index={8} />
    </div>
  );
}

function Billing() {
  const { plan, invoicePaid, cardLast4, done, paidPlan, payment } = useApp((s) => s.operator);
  const [paying, setPaying] = useState(false);
  // A paid invoice always shows the plan that was charged, whatever is selected now.
  const p = PLANS.find((x) => x.id === (invoicePaid ? paidPlan : plan)) ?? PLANS[1];
  const max = Math.max(...USAGE_DAYS);
  const used = 98200;
  const lines = [
    { id: 'i1', item: `${p.name} plan, November`, qty: '1', amount: p.price },
    { id: 'i2', item: `Included spins (${p.spins.split(' ')[0]})`, qty: p.spins.split(' ')[0], amount: 0 },
    { id: 'i3', item: 'Overage spins at 2.0 EUR per 1,000', qty: '0', amount: 0 },
  ];
  const others = STEPS.filter((s) => s.id !== 'billing' && !done[s.id]).map((s) => s.label);
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Spins this month" value={used.toLocaleString('en-US')} hint="of 150,000 included" delta={12.4} />
        <StatTile label="Active players" value="4,120" delta={6.1} />
        <StatTile label="Next invoice" value={`${p.price} EUR`} hint={invoicePaid ? 'paid for November' : 'due 30 Nov'} />
      </div>
      <Card title="Spins per day (last 14 days, thousands)">
        <div className="flex h-32 items-end gap-1" role="img" aria-label={`Daily spins, thousands: ${USAGE_DAYS.join(', ')}`}>
          {USAGE_DAYS.map((v, i) => (
            <div key={i} className="flex-1 rounded-t-sm bg-primary" style={{ height: `${(v / max) * 100}%` }} />
          ))}
        </div>
      </Card>
      {(paying || payment?.status === 'processing') && !invoicePaid ? (
        <Checkout plan={p.id} amount={p.price} description="Invoice, November 2026" onCancel={() => setPaying(false)} />
      ) : (
        <Card
          title="Invoice, November 2026"
          actions={
            <>
              <StatusPill status={invoicePaid ? 'paid' : 'open'} />
              {!invoicePaid && <Button size="sm" onClick={() => setPaying(true)}>Pay invoice</Button>}
            </>
          }
          flush
        >
          <Table
            caption="Invoice lines"
            rowKey={(l) => l.id}
            rows={lines}
            columns={[
              { key: 'i', header: 'Item', render: (l) => l.item },
              { key: 'q', header: 'Qty', align: 'right', render: (l) => l.qty, hideOnMobile: true },
              { key: 'a', header: 'Amount (EUR)', align: 'right', render: (l) => l.amount.toFixed(2) },
            ]}
          />
          <p className="flex justify-between border-t border-border px-4 py-3 text-sm font-semibold"><span>Total</span><span className="tabular-nums">{p.price.toFixed(2)} EUR</span></p>
          {invoicePaid && <p className="border-t border-border px-4 py-3 text-sm text-success" role="status">Paid with the test card ending {cardLast4}. Receipt sent (mock).</p>}
        </Card>
      )}
      {done.billing && (
        others.length === 0 ? (
          <Alert tone="success"><span role="status"><strong>Setup complete.</strong> Plan paid, live, rules and wheel published.</span></Alert>
        ) : (
          <Alert tone="warning"><span role="status">Finished, but these steps are still open: {others.join(', ')}.</span></Alert>
        )
      )}
      <StepNav index={9} />
    </div>
  );
}
