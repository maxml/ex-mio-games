import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createEvent, uuidv7, type CreateTenantRequest, type Tenant } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { DuplicateSlugError, TenantsRepository } from '../model/tenants.repository';

@Injectable()
export class TenantsService {
  constructor(
    private readonly db: Db,
    private readonly tenants: TenantsRepository,
  ) {}

  /**
   * Create a tenant and announce it. The row and the outbox event commit in one
   * transaction: either both exist or neither does.
   */
  async create(input: CreateTenantRequest): Promise<Tenant> {
    const id = uuidv7();
    try {
      return await this.db.platformTx(async (tx) => {
        const tenant = await this.tenants.insert(tx, { id, name: input.name, slug: input.slug });
        await this.db.publish(
          tx,
          createEvent({
            type: 'identity.tenant.created',
            tenantId: tenant.id,
            payload: { name: tenant.name, slug: tenant.slug },
          }),
        );
        return tenant;
      });
    } catch (err) {
      if (err instanceof DuplicateSlugError) throw new ConflictException('slug already taken');
      throw err;
    }
  }

  async get(id: string): Promise<Tenant> {
    const found = await this.db.platformTx((tx) => this.tenants.findById(tx, id));
    if (!found) throw new NotFoundException('tenant not found');
    return found;
  }
}
