import { Injectable } from '@nestjs/common';
import { uuidv7, type PlayerLookup } from '@ex-mio/contracts';
import { IdentityError, UniqueViolationError } from '../errors';
import type { PlayerLinkRow, Repos, UnitOfWork } from '../model/ports';
import { AccessService, effectiveTenant, type Subject } from './access.service';

/**
 * Player identity: `(tenant, platform, external_player_id) -> user_id`, one writer. A deposit, an
 * internal resolve and a launch all come through `resolveOrCreate`, so they agree on the user.
 */
@Injectable()
export class PlayersService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repos: Repos,
    private readonly access: AccessService,
  ) {}

  async resolveOrCreate(
    tenantId: string,
    platform: string,
    externalPlayerId: string,
  ): Promise<{ user_id: string; created: boolean }> {
    const platformName = (platform ?? '').trim();
    const ext = (externalPlayerId ?? '').trim();
    if (!platformName || platformName.length > 64 || !ext || ext.length > 128) {
      throw new IdentityError('VALIDATION_FAILED', 'platform and external player id are required');
    }
    const attempt = (): Promise<{ user_id: string; created: boolean }> =>
      this.uow.run(tenantId, async (tx) => {
        const found = await this.repos.players.find(tx, tenantId, platformName, ext);
        if (found) return { user_id: found.user_id, created: false };
        const userId = uuidv7();
        await this.repos.users.insert(tx, {
          tenant_id: tenantId,
          id: userId,
          email: null,
          kind: 'player',
        });
        await this.repos.users.insertRole(tx, tenantId, userId, 'player');
        await this.repos.players.insert(tx, tenantId, {
          user_id: userId,
          platform: platformName,
          external_player_id: ext,
        });
        return { user_id: userId, created: true };
      });
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof UniqueViolationError)) throw err;
      // a concurrent first resolution won: read what it wrote (the losing transaction rolled back)
      const winner = await this.uow.run(tenantId, (tx) =>
        this.repos.players.find(tx, tenantId, platformName, ext),
      );
      if (!winner) throw err;
      return { user_id: winner.user_id, created: false };
    }
  }

  /** X-8 (internal): the casino-side id of a player of this tenant; NOT_FOUND after an erasure. */
  async linkOf(
    tenantId: string,
    userId: string,
  ): Promise<{ platform: string; external_player_id: string }> {
    const link = await this.uow.run(tenantId, (tx) =>
      this.repos.players.findByUser(tx, tenantId, userId),
    );
    if (!link) throw new IdentityError('NOT_FOUND', 'player link not found');
    return { platform: link.platform, external_player_id: link.external_player_id };
  }

  /** Erasure (MIO-107): delete the mapping to the casino id. The player's own id stays. */
  async erase(tenantId: string, userId: string): Promise<boolean> {
    return this.uow.run(tenantId, (tx) => this.repos.players.delete(tx, tenantId, userId));
  }

  async links(tenantId: string): Promise<PlayerLinkRow[]> {
    return this.uow.run(tenantId, (tx) => this.repos.players.list(tx, tenantId));
  }

  /** Operator (or the player itself) reads a link; another tenant's or another player's is NOT_FOUND. */
  async lookup(subject: Subject, userId: string): Promise<PlayerLookup> {
    const tenantId = effectiveTenant(subject);
    const action = subject.roles.includes('player') ? 'player.self.read' : 'players.read';
    await this.access.authorize(subject, action, { tenant_id: tenantId, user_id: userId });
    const link = await this.uow.run(tenantId, (tx) =>
      this.repos.players.findByUser(tx, tenantId, userId),
    );
    if (!link) throw new IdentityError('NOT_FOUND', 'player not found');
    return {
      user_id: link.user_id,
      platform: link.platform,
      external_player_id: link.external_player_id,
    };
  }
}
