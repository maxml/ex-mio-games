import { StoreTemplate } from '@ex-mio/ui';
import { appStore, useApp } from '../../state/store';
import { useOperatorShell } from './shell';

let seq = 0;

/** Engagement: the bonus store catalog. Staff read it (no write control is drawn); an admin changes it. */
export function StoreScreen({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { shell } = useOperatorShell(denied);
  const catalog = useApp((s) => s.operator.catalog);
  return (
    <StoreTemplate
      shell={shell}
      readOnly={readOnly}
      items={catalog.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        priceCoins: i.priceCoins,
        visible: i.visible,
      }))}
      onAddItem={(v) =>
        appStore.dispatch({
          type: 'catalog/add',
          id: `s-new-${++seq}`,
          name: v.name,
          price: v.priceCoins,
          bonusEur: v.bonusEur,
        })
      }
      onPrice={(id, price) => appStore.dispatch({ type: 'catalog/price', id, price })}
      onVisibility={(id, on) => appStore.dispatch({ type: 'catalog/visible', id, on })}
    />
  );
}
