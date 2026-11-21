import { Injectable } from '@nestjs/common';
import type { Tenant } from '@ex-mio/contracts';
import type { Tx } from '@ex-mio/service-kit';
import { TenantEntity } from './tenant.entity';

export class DuplicateSlugError extends Error {
  constructor() {
    super('slug already taken');
    this.name = 'DuplicateSlugError';
  }
}

function toTenant(e: TenantEntity): Tenant {
  return { id: e.id, name: e.name, slug: e.slug, created_at: e.createdAt.toISOString() };
}

@Injectable()
export class TenantsRepository {
  async insert(tx: Tx, input: { id: string; name: string; slug: string }): Promise<Tenant> {
    const repo = tx.getRepository(TenantEntity);
    if (await repo.existsBy({ slug: input.slug })) throw new DuplicateSlugError();
    return toTenant(await repo.save(repo.create(input)));
  }

  async findById(tx: Tx, id: string): Promise<Tenant | null> {
    const found = await tx.getRepository(TenantEntity).findOneBy({ id });
    return found ? toTenant(found) : null;
  }
}
