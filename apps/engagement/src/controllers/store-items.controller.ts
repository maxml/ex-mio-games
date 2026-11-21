import { Body, Controller, Get, Headers, Param, Patch, Post, UseFilters } from '@nestjs/common';
import { z } from 'zod';
import { CreateItemRequest, UpdateItemRequest, Uuid, type StoreItem } from '@ex-mio/contracts';
import { parseInput } from '@ex-mio/service-kit';
import { assertItemPrice, StoreItemsService } from '../services/store-items.service';
import { readPrincipal, requireRole } from './principal';
import { StoreErrorFilter } from './store-error.filter';

const IdParam = z.object({ id: Uuid });

/**
 * The bonus catalog (spec section 7): players read active items, `operator_admin` edits them and
 * `operator_staff` reads all of them. Roles are identity's (X-15), from the verified token.
 */
@Controller()
@UseFilters(StoreErrorFilter)
export class StoreItemsController {
  constructor(private readonly items: StoreItemsService) {}

  /** Active items of the caller's tenant. */
  @Get('v1/store/items')
  listActive(@Headers() headers: Record<string, unknown>): Promise<StoreItem[]> {
    readPrincipal(headers);
    return this.items.listActive();
  }

  /** Every item of the tenant, inactive ones too. */
  @Get('v1/operator/store/items')
  listAll(@Headers() headers: Record<string, unknown>): Promise<StoreItem[]> {
    requireRole(readPrincipal(headers), 'operator_admin', 'operator_staff');
    return this.items.listAll();
  }

  @Post('v1/store/items')
  create(@Headers() headers: Record<string, unknown>, @Body() body: unknown): Promise<StoreItem> {
    requireRole(readPrincipal(headers), 'operator_admin');
    const input = parseInput(CreateItemRequest, body);
    assertItemPrice(input.price); // 422 item_price_invalid; a wrong type already failed as 400
    return this.items.create(input);
  }

  @Patch('v1/store/items/:id')
  update(
    @Headers() headers: Record<string, unknown>,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<StoreItem> {
    requireRole(readPrincipal(headers), 'operator_admin');
    const { id } = parseInput(IdParam, params);
    const patch = parseInput(UpdateItemRequest, body);
    if (patch.price !== undefined) assertItemPrice(patch.price);
    return this.items.update(id, patch);
  }
}
