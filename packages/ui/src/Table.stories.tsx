import type { Meta, StoryObj } from '@storybook/react';
import { StatusPill, type Status } from './StatusPill';
import { Table } from './Table';

interface Row {
  id: string;
  player: string;
  item: string;
  status: Status;
}

const ROWS: Row[] = [
  { id: 'rd-1', player: 'p_7f3a', item: '20 free spins', status: 'issued' },
  { id: 'rd-2', player: 'p_c91d', item: '5 EUR bonus', status: 'pending' },
  { id: 'rd-3', player: 'p_22be', item: '50 free spins', status: 'failed' },
];

const meta = { title: 'Primitives/Table', component: Table<Row> } satisfies Meta<typeof Table<Row>>;

export default meta;
type Story = StoryObj<typeof meta>;

const COLUMNS = [
  { key: 'p', header: 'Player', render: (r: Row) => r.player },
  { key: 'i', header: 'Item', render: (r: Row) => r.item, hideOnMobile: true },
  { key: 's', header: 'Status', render: (r: Row) => <StatusPill status={r.status} /> },
];

export const Default: Story = {
  args: { caption: 'Redemptions', rowKey: (r) => r.id, rows: ROWS, columns: COLUMNS },
};
export const Empty: Story = {
  args: {
    caption: 'Redemptions',
    rowKey: (r) => r.id,
    rows: [],
    columns: COLUMNS,
    empty: 'No redemptions with this status.',
  },
};
