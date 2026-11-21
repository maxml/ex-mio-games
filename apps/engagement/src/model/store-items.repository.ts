import { Injectable } from '@nestjs/common';
import type { CreateItemRequest, StoreItem, UpdateItemRequest } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';

interface ItemRow {
  id: string;
  version: number;
  name: string;
  description: string;
  image_url: string | null;
  price: number;
  reward: StoreItem['reward'];
  stock: number | null;
  per_player_limit: number | null;
  active: boolean;
}

const COLUMNS = `"id", "version", "name", "description", "image_url", "price", "reward", "stock",
  "per_player_limit", "active"`;

const toItem = (r: ItemRow): StoreItem => ({
  id: r.id,
  name: r.name,
  description: r.description,
  image_url: r.image_url,
  price: r.price,
  reward: r.reward,
  stock: r.stock,
  per_player_limit: r.per_player_limit,
  active: r.active,
  version: r.version,
});

/** Catalog rows of the transaction's tenant (row-level security picks them). */
@Injectable()
export class StoreItemsRepository {
  async insert(tx: Tx, id: string, tenantId: string, input: CreateItemRequest): Promise<StoreItem> {
    const rows: ItemRow[] = await tx.query(
      `INSERT INTO "store_items" ("id", "tenant_id", "version", "name", "description", "image_url",
         "price", "reward", "stock", "per_player_limit", "active")
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLUMNS}`,
      [
        id,
        tenantId,
        input.name,
        input.description,
        input.image_url ?? null,
        input.price,
        JSON.stringify(input.reward),
        input.stock,
        input.per_player_limit,
        input.active,
      ],
    );
    return toItem(rows[0]!);
  }

  /**
   * Edit an item: only the given fields change and the version goes up, so a redemption that
   * froze version N keeps its price and reward. Null when the item does not exist for the tenant.
   */
  async update(tx: Tx, id: string, patch: UpdateItemRequest): Promise<StoreItem | null> {
    const columns: [string, unknown][] = [];
    if (patch.name !== undefined) columns.push(['name', patch.name]);
    if (patch.description !== undefined) columns.push(['description', patch.description]);
    if (patch.image_url !== undefined) columns.push(['image_url', patch.image_url]);
    if (patch.price !== undefined) columns.push(['price', patch.price]);
    if (patch.reward !== undefined) columns.push(['reward', JSON.stringify(patch.reward)]);
    if (patch.stock !== undefined) columns.push(['stock', patch.stock]);
    if (patch.per_player_limit !== undefined)
      columns.push(['per_player_limit', patch.per_player_limit]);
    if (patch.active !== undefined) columns.push(['active', patch.active]);
    const sets = columns.map(([name], i) => `"${name}" = $${i + 2}`);
    const rows: ItemRow[] = await tx.query(
      `WITH u AS (
         UPDATE "store_items" SET ${[...sets, `"version" = "version" + 1`].join(', ')}
         WHERE "id" = $1 RETURNING ${COLUMNS})
       SELECT * FROM u`,
      [id, ...columns.map(([, value]) => value)],
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  async list(tx: Tx, activeOnly: boolean): Promise<StoreItem[]> {
    const rows: ItemRow[] = await tx.query(
      `SELECT ${COLUMNS} FROM "store_items" ${activeOnly ? 'WHERE "active"' : ''}
       ORDER BY "created_at", "id"`,
    );
    return rows.map(toItem);
  }
}
