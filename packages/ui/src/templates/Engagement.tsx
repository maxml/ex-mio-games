import { useState } from 'react';
import { Button } from '../Button';
import { ActivityList } from '../ActivityList';
import { Card } from '../Card';
import { CellText } from '../CellText';
import { Checkbox } from '../Checkbox';
import { EmptyState } from '../EmptyState';
import { Grid, Stack } from '../Layout';
import { PriceField, StoreItemForm, type StoreItemValues } from '../StoreItemForm';
import { RuleEditor, rulesValid, type RuleValues } from '../RuleEditor';
import { Badge, StatusPill } from '../StatusPill';
import { Table } from '../Table';
import { Wheel } from '../Wheel';
import { WeightTable, type WeightRow } from '../WeightTable';
import { OperatorShell, ReadOnlyNotice, StateBody, type TemplateBase } from './OperatorShell';

// The three Engagement pages: Rules, Wheel, Bonus store.

export interface StoreAdminItem {
  id: string;
  name: string;
  priceCoins: number;
  /** Shown under the name when there is no bonus amount to show. */
  description?: string;
  bonusEur?: number;
  visible: boolean;
}

export interface RulesTemplateProps extends TemplateBase {
  value: RuleValues;
  onChange: (next: RuleValues) => void;
  /** Result text the caller computes from the same rules the server applies. */
  preview: string;
  onSave: (value: RuleValues) => void;
  busy?: boolean;
}

/** Engagement: the deposit-to-spins rule. */
export function RulesTemplate({
  shell,
  state,
  errorText,
  readOnly,
  value,
  onChange,
  preview,
  onSave,
  busy,
}: RulesTemplateProps) {
  return (
    <OperatorShell {...shell} current="rules" title="Rules" intro="When does a deposit earn spins.">
      <StateBody
        state={state}
        errorText={errorText}
        empty={
          <EmptyState title="No rule yet">Set the first rule to start granting spins.</EmptyState>
        }
      >
        {readOnly ? (
          <Stack>
            <ReadOnlyNotice />
            <ActivityList
              items={[
                { id: 'min', title: 'Minimum deposit', trailing: `${value.min} EUR` },
                { id: 'spins', title: 'Spins granted', trailing: String(value.spins) },
                { id: 'cap', title: 'Daily spin cap per player', trailing: String(value.cap) },
              ]}
            />
          </Stack>
        ) : (
          <Card title="Spin rule">
            <Stack>
              <RuleEditor value={value} onChange={onChange} preview={preview} />
              <div>
                <Button disabled={!rulesValid(value)} loading={busy} onClick={() => onSave(value)}>
                  Save rule
                </Button>
              </div>
            </Stack>
          </Card>
        )}
      </StateBody>
    </OperatorShell>
  );
}

export interface WheelVersion {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  at: string;
}

export interface WheelTemplateProps extends TemplateBase {
  rows: WeightRow[];
  weights: number[];
  onChangeWeight: (index: number, weight: number) => void;
  onPublish: (weights: number[]) => void;
  versions: WheelVersion[];
  busy?: boolean;
}

/** Engagement: draft weights, a preview wheel, and the published versions. */
export function WheelTemplate({
  shell,
  state,
  errorText,
  readOnly,
  rows,
  weights,
  onChangeWeight,
  onPublish,
  versions,
  busy,
}: WheelTemplateProps) {
  const valid = weights.length === rows.length && weights.every((w) => w > 0);
  return (
    <OperatorShell
      {...shell}
      current="wheel"
      title="Wheel"
      intro="Draft the reward weights, then publish a version."
    >
      <StateBody
        state={state}
        errorText={errorText}
        empty={<EmptyState title="No wheel yet">Add rewards to build the first wheel.</EmptyState>}
      >
        <Stack gap={6}>
          {readOnly ? (
            <ReadOnlyNotice />
          ) : (
            <Grid cols={2}>
              <Card title="Draft weights">
                <Stack>
                  <WeightTable rows={rows} weights={weights} onChange={onChangeWeight} />
                  <div>
                    <Button disabled={!valid} loading={busy} onClick={() => onPublish(weights)}>
                      Publish
                    </Button>
                  </div>
                </Stack>
              </Card>
              <Card title="Preview">
                <Wheel
                  segments={rows.map((r) => ({ id: r.id, label: String(r.coins) }))}
                  spin={null}
                  size={260}
                />
              </Card>
            </Grid>
          )}
          <Card title="Versions" flush>
            <Table
              caption="Wheel versions"
              rowKey={(v) => v.id}
              rows={versions}
              empty="No versions published yet."
              columns={[
                { key: 'v', header: 'Version', render: (v) => `Version ${v.version}` },
                { key: 's', header: 'Status', render: (v) => <StatusPill status={v.status} /> },
                { key: 'a', header: 'Date', render: (v) => v.at },
              ]}
            />
          </Card>
        </Stack>
      </StateBody>
    </OperatorShell>
  );
}

export interface StoreTemplateProps extends TemplateBase {
  items: StoreAdminItem[];
  onAddItem: (values: StoreItemValues) => void;
  onPrice: (itemId: string, price: number) => void;
  onVisibility: (itemId: string, visible: boolean) => void;
}

/** Engagement: the bonus store catalog. A read role sees the list without any write control. */
export function StoreTemplate({
  shell,
  state,
  errorText,
  readOnly,
  items,
  onAddItem,
  onPrice,
  onVisibility,
}: StoreTemplateProps) {
  const [adding, setAdding] = useState(false);
  const empty = (
    <EmptyState
      title="No items yet."
      action={
        readOnly || adding ? undefined : (
          <Button onClick={() => setAdding(true)}>Add your first item</Button>
        )
      }
    >
      Items you add here show up in the player store.
    </EmptyState>
  );
  return (
    <OperatorShell
      {...shell}
      current="store"
      title="Bonus store"
      intro="What players can buy with coins."
    >
      <StateBody state={state} errorText={errorText} empty={empty}>
        <Stack gap={6}>
          {items.length === 0 ? (
            empty
          ) : (
            <Card title="Catalog" flush>
              <Table
                caption="Store items"
                rowKey={(i) => i.id}
                rows={items}
                columns={[
                  {
                    key: 'n',
                    header: 'Item',
                    render: (i) => (
                      <CellText
                        primary={i.name}
                        secondary={
                          i.bonusEur === undefined ? i.description : `Bonus ${i.bonusEur} EUR`
                        }
                      />
                    ),
                  },
                  {
                    key: 'p',
                    header: 'Price (coins)',
                    align: 'right',
                    render: (i) =>
                      readOnly ? (
                        i.priceCoins.toLocaleString('en-US')
                      ) : (
                        <PriceField
                          size="sm"
                          hideLabel
                          label={`Price for ${i.name}`}
                          value={i.priceCoins}
                          onChange={(p) => onPrice(i.id, p)}
                        />
                      ),
                  },
                  {
                    key: 'v',
                    header: 'Visible',
                    render: (i) =>
                      readOnly ? (
                        <Badge>{i.visible ? 'Visible' : 'Hidden'}</Badge>
                      ) : (
                        <Checkbox
                          hideLabel
                          label={`Visible: ${i.name}`}
                          checked={i.visible}
                          onChange={(e) => onVisibility(i.id, e.target.checked)}
                        />
                      ),
                  },
                ]}
              />
            </Card>
          )}
          {!readOnly && (items.length > 0 || adding) && <StoreItemForm onSubmit={onAddItem} />}
          {readOnly && <ReadOnlyNotice />}
        </Stack>
      </StateBody>
    </OperatorShell>
  );
}
