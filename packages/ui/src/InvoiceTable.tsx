import { Button } from './Button';
import { StatusPill, type Status } from './StatusPill';
import { Table } from './Table';

export interface InvoiceRow {
  id: string;
  period: string;
  amountEur: number;
  status: Extract<Status, 'paid' | 'open' | 'past_due'>;
}

export interface InvoiceTableProps {
  invoices: InvoiceRow[];
  /** When set, an open invoice gets a Pay button. Omit it for read-only roles. */
  onPay?: (invoiceId: string) => void;
}

const eur = (n: number) => `${n.toFixed(2)} EUR`;

/** Invoices with a status, an optional Pay action, and the total row. */
export function InvoiceTable({ invoices, onPay }: InvoiceTableProps) {
  const total = invoices.reduce((sum, i) => sum + i.amountEur, 0);
  return (
    <div>
      <Table
        caption="Invoices"
        rowKey={(i) => i.id}
        rows={invoices}
        empty="No invoices yet."
        columns={[
          { key: 'p', header: 'Period', render: (i) => i.period },
          { key: 'a', header: 'Amount', align: 'right', render: (i) => eur(i.amountEur) },
          { key: 's', header: 'Status', render: (i) => <StatusPill status={i.status} /> },
          ...(onPay
            ? [
                {
                  key: 'pay',
                  header: 'Action',
                  render: (i: InvoiceRow) =>
                    i.status === 'paid' ? null : (
                      <Button size="sm" onClick={() => onPay(i.id)}>
                        Pay {i.period}
                      </Button>
                    ),
                },
              ]
            : []),
        ]}
      />
      {invoices.length > 0 && (
        <p className="mt-2 px-4 text-right text-sm font-semibold tabular-nums">
          Total: {eur(total)}
        </p>
      )}
    </div>
  );
}
