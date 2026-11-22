import { Inject, Injectable, Optional } from '@nestjs/common';
import type { EventEnvelope, WalletBalance } from '@ex-mio/contracts';
import { COIN_CURRENCY } from '@ex-mio/contracts';
import { Db, type RedisCache } from '@ex-mio/service-kit';
import { currentTenant, runWithTenant, tenantCacheKey } from '@ex-mio/tenancy';
import { LedgerRepository } from '../model/ledger.repository';
import { LedgerError } from './ledger.errors';

/** Injection token of the Redis projection (`null` when Redis is not configured). */
export const BALANCE_CACHE = Symbol('BALANCE_CACHE');

/** A cached balance is a hint for read APIs; it expires on its own even if no event arrives. */
const CACHE_TTL_SECONDS = 300;

interface CachedBalance {
  available: number;
  held: number;
}

/**
 * The balance read path and its Redis projection. The projection is eventually consistent (refreshed
 * by `onCoinEvent`) and used ONLY here: commands and the spin credit never receive the cache, and
 * decide from Postgres (D-9). A cache failure is swallowed and the database answers.
 */
@Injectable()
export class BalanceService {
  constructor(
    private readonly db: Db,
    private readonly repo: LedgerRepository,
    @Optional() @Inject(BALANCE_CACHE) private readonly cache: RedisCache | null,
  ) {}

  /**
   * The player's balance in ONE environment, a required argument (INV-ENV-INPUT: no default). The
   * environment comes from the token claim at the controller (or the required query of the
   * service-only route), never from a user-supplied value; a production read cannot see a
   * sandbox wallet and the other way round (X-2).
   */
  async readByPlayer(playerId: string, opts: { sandbox: boolean }): Promise<WalletBalance> {
    const { tenantId } = currentTenant();
    const walletId = await this.db.tenantTx(async (tx) => {
      const wallet = await this.repo.walletByPlayer(tx, tenantId, playerId, opts.sandbox);
      return wallet?.walletId ?? null;
    });
    if (!walletId) throw new LedgerError('wallet_not_found');
    return this.readBalance(tenantId, walletId);
  }

  async readByWallet(walletId: string): Promise<WalletBalance> {
    const { tenantId } = currentTenant();
    const wallet = await this.db.tenantTx((tx) => this.repo.walletById(tx, tenantId, walletId));
    if (!wallet) throw new LedgerError('wallet_not_found');
    return this.readBalance(tenantId, walletId);
  }

  /** Drop a wallet's cached balance when a coin event says it changed. */
  async onCoinEvent(event: EventEnvelope): Promise<void> {
    if (!this.cache) return;
    const payload = event.payload as { wallet_id?: string; player_id?: string };
    const walletId =
      payload.wallet_id ??
      (payload.player_id
        ? await this.walletOfPlayer(event.tenant_id, payload.player_id, event.sandbox)
        : null);
    if (!walletId) return;
    try {
      await this.cache.del(tenantCacheKey(event.tenant_id, 'balance', walletId));
    } catch {
      /* Redis is a projection: a failed invalidation only means the entry expires on its own. */
    }
  }

  private walletOfPlayer(
    tenantId: string,
    playerId: string,
    sandbox: boolean,
  ): Promise<string | null> {
    return runWithTenant({ tenantId }, () =>
      this.db.tenantTx(async (tx) => {
        const wallet = await this.repo.walletByPlayer(tx, tenantId, playerId, sandbox);
        return wallet?.walletId ?? null;
      }),
    );
  }

  private async readBalance(tenantId: string, walletId: string): Promise<WalletBalance> {
    const key = tenantCacheKey(tenantId, 'balance', walletId);
    const hit = await this.cached(key);
    if (hit) return { wallet_id: walletId, ...hit, currency: COIN_CURRENCY };
    const fresh = await this.db.tenantTx((tx) => this.repo.walletBalance(tx, tenantId, walletId));
    await this.remember(key, fresh);
    return { wallet_id: walletId, ...fresh, currency: COIN_CURRENCY };
  }

  private async cached(key: string): Promise<CachedBalance | null> {
    if (!this.cache) return null;
    try {
      const raw = await this.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<CachedBalance>;
      return Number.isInteger(parsed.available) && Number.isInteger(parsed.held)
        ? { available: parsed.available as number, held: parsed.held as number }
        : null;
    } catch {
      return null;
    }
  }

  private async remember(key: string, balance: CachedBalance): Promise<void> {
    if (!this.cache) return;
    try {
      await this.cache.set(key, JSON.stringify(balance), CACHE_TTL_SECONDS);
    } catch {
      /* a failed write only means the next read goes to the database again */
    }
  }
}
