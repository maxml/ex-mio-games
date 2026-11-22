import { Module, type DynamicModule } from '@nestjs/common';
import type { CasinoRewardPorts, RewardRequestBuilder } from '@ex-mio/contracts';
import { Db } from '@ex-mio/service-kit';
import { RedemptionsController } from '../controllers/redemptions.controller';
import { StoreItemsController } from '../controllers/store-items.controller';
import { PgRedemptionStore } from '../model/redemption.store';
import { StoreItemsRepository } from '../model/store-items.repository';
import { RedemptionSagaService } from '../services/redemption-saga.service';
import { RedemptionsService } from '../services/redemptions.service';
import { StoreItemsService } from '../services/store-items.service';
import { HttpCoinsClient } from './http-coins.client';
import type { CoinsPort, RedemptionStore } from './ports';
import { RedemptionSweeper, SWEEPER_INTERVAL_MS } from './sweeper';
import { COINS_PORT, REDEMPTION_SAGA, REDEMPTION_STORE } from './tokens';

export interface StoreModuleOptions {
  paymentsUrl: string;
  /** A fresh service token with `aud=payments` (identity client credentials, D-4, D-14). */
  paymentsToken: () => Promise<string>;
  /** Sweep every N ms; 0 turns the sweeper off. */
  sweeperIntervalMs: number;
  /**
   * The REAL L3 adapter registry per tenant and environment (D-12, D-20): the same
   * `CasinoRewardPorts` the ingest side builds from the tenant's integration credentials. There is
   * no default and no "unconfigured" stand-in: an order for a tenant without an adapter ends in
   * NEEDS_REVIEW `no_adapter` with its coins held, decided by the saga from `undefined`.
   */
  ports: CasinoRewardPorts;
  /** Builds the casino request from identity's player link (D-20), never from the user id. */
  requests: RewardRequestBuilder;
}

@Module({})
export class StoreModule {
  static register(options: StoreModuleOptions): DynamicModule {
    return {
      module: StoreModule,
      controllers: [RedemptionsController, StoreItemsController],
      providers: [
        StoreItemsRepository,
        StoreItemsService,
        RedemptionsService,
        RedemptionSweeper,
        { provide: SWEEPER_INTERVAL_MS, useValue: options.sweeperIntervalMs },
        {
          provide: REDEMPTION_STORE,
          inject: [Db],
          useFactory: (db: Db): RedemptionStore =>
            new PgRedemptionStore(db, { now: () => new Date() }),
        },
        {
          provide: COINS_PORT,
          useFactory: (): CoinsPort =>
            new HttpCoinsClient({
              baseUrl: options.paymentsUrl,
              serviceToken: options.paymentsToken,
            }),
        },
        {
          provide: REDEMPTION_SAGA,
          inject: [REDEMPTION_STORE, COINS_PORT],
          useFactory: (store: RedemptionStore, coins: CoinsPort) =>
            new RedemptionSagaService({
              store,
              coins,
              ports: options.ports,
              requests: options.requests,
              clock: { now: () => new Date() },
              random: Math.random,
            }),
        },
      ],
      exports: [REDEMPTION_SAGA, REDEMPTION_STORE],
    };
  }
}
