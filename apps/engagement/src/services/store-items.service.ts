import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type CreateItemRequest,
  type StoreItem,
  type UpdateItemRequest,
} from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { currentTenant } from '@ex-mio/tenancy';
import { StoreItemsRepository } from '../model/store-items.repository';
import { SagaError } from '../redemptions/saga-error';

/** Price is a positive whole number of coins; anything else is 422 `item_price_invalid`. */
export function assertItemPrice(price: unknown): asserts price is number {
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price <= 0)
    throw new SagaError('item_price_invalid', 'price must be a positive whole number of coins');
}

@Injectable()
export class StoreItemsService {
  constructor(
    private readonly db: Db,
    private readonly items: StoreItemsRepository,
  ) {}

  create(input: CreateItemRequest): Promise<StoreItem> {
    assertItemPrice(input.price);
    const { tenantId } = currentTenant();
    return this.db.tenantTx((tx) => this.items.insert(tx, uuidv7(), tenantId, input));
  }

  async update(id: string, patch: UpdateItemRequest): Promise<StoreItem> {
    if (patch.price !== undefined) assertItemPrice(patch.price);
    const item = await this.db.tenantTx((tx) => this.items.update(tx, id, patch));
    if (!item) throw new SagaError('item_not_found');
    return item;
  }

  /** What players see: active items only. */
  listActive(): Promise<StoreItem[]> {
    return this.db.tenantTx((tx) => this.items.list(tx, true));
  }

  /** What operators see: every item of the tenant. */
  listAll(): Promise<StoreItem[]> {
    return this.db.tenantTx((tx) => this.items.list(tx, false));
  }
}
