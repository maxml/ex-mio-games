import { Card, StatTile, StatusPill, Table } from '../components';
import { FUNNEL, TENANTS } from '../mock/data';

export function AdminScreen() {
  const mrr = TENANTS.reduce((s, t) => s + t.mrr, 0);
  const spins = TENANTS.reduce((s, t) => s + t.spins, 0);
  const paying = TENANTS.filter((t) => t.mrr > 0).length;
  const top = FUNNEL[0].value;
  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <h1 className="font-display text-2xl font-bold">Platform admin</h1>
      <p className="mb-4 text-sm text-fg-muted">Our own view across all operators. Mock numbers.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="MRR" value={`${mrr.toLocaleString('en-US')} EUR`} delta={8.2} />
        <StatTile label="Paying operators" value={`${paying} of ${TENANTS.length}`} />
        <StatTile label="Spins this month" value={spins.toLocaleString('en-US')} delta={14.9} />
        <StatTile label="Signup to paid" value={`${((FUNNEL[5].value / top) * 100).toFixed(0)}%`} hint="last 30 days" delta={-1.3} />
      </div>
      <Card className="mt-4" title="Operators" description="Usage per operator, this month." flush>
        <Table
          caption="Operators"
          rowKey={(t) => t.id}
          rows={TENANTS}
          columns={[
            { key: 'n', header: 'Operator', render: (t) => <span className="font-semibold">{t.name}</span> },
            { key: 'p', header: 'Plan', render: (t) => t.plan, hideOnMobile: true },
            { key: 's', header: 'Status', render: (t) => <StatusPill status={t.status} /> },
            { key: 'm', header: 'MRR (EUR)', align: 'right', render: (t) => t.mrr },
            { key: 'u', header: 'Spins', align: 'right', render: (t) => t.spins.toLocaleString('en-US'), hideOnMobile: true },
            { key: 'd', header: 'Depositors', align: 'right', render: (t) => t.depositors.toLocaleString('en-US'), hideOnMobile: true },
          ]}
        />
      </Card>
      <Card className="mt-4" title="Operator funnel" description="Where operators drop out between signup and first payment.">
        <ol className="grid gap-3">
          {FUNNEL.map((f, i) => (
            <li key={f.step}>
              <div className="flex justify-between text-sm">
                <span>{f.step}</span>
                <span className="tabular-nums">
                  {f.value}
                  {i > 0 && <span className="text-fg-muted"> ({((f.value / FUNNEL[i - 1].value) * 100).toFixed(0)}% of previous)</span>}
                </span>
              </div>
              <div className="mt-1 h-3 rounded-sm bg-surface-2">
                <div className="h-3 rounded-sm bg-primary" style={{ width: `${(f.value / top) * 100}%` }} />
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
