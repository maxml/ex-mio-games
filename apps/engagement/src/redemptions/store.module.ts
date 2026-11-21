import { Module, type DynamicModule } from '@nestjs/common';
import type { CasinoRewardPort } from '@ex-mio/contracts';
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
import { buildRewardRequest } from './reward-request';
import { RedemptionSweeper, SWEEPER_INTERVAL_MS } from './sweeper';
import { CASINO_ADAPTERS, COINS_PORT, REDEMPTION_SAGA, REDEMPTION_STORE } from './tokens';

export type CasinoAdapters = (tenantId: string, sandbox: boolean) => CasinoRewardPort;

export interface StoreModuleOptions {
  paymentsUrl: string;
  serviceToken: string;
  /** Sweep every N ms; 0 turns the sweeper off. */
  sweeperIntervalMs: number;
  /**
   * The casino adapters (sandbox and production), provided by the integrations module. Without
   * them every issue call answers `unknown`: nothing is ever issued or released, orders end in
   * NEEDS_REVIEW with their coins held.
   */
  casinoAdapters?: CasinoAdapters;
}

const unconfigured: CasinoRewardPort = {
  issueReward: async () => ({ kind: 'unknown' }),
  getRewardStatus: async () => ({ kind: 'unknown' }),
};

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
              serviceId: 'engagement',
              serviceToken: options.serviceToken,
            }),
        },
        {
          provide: CASINO_ADAPTERS,
          useValue: options.casinoAdapters ?? ((): CasinoRewardPort => unconfigured),
        },
        {
          provide: REDEMPTION_SAGA,
          inject: [REDEMPTION_STORE, COINS_PORT, CASINO_ADAPTERS],
          useFactory: (store: RedemptionStore, coins: CoinsPort, adapters: CasinoAdapters) =>
            new RedemptionSagaService({
              store,
              coins,
              adapterFor: adapters,
              rewardRequest: buildRewardRequest,
              clock: { now: () => new Date() },
              random: Math.random,
            }),
        },
      ],
      exports: [REDEMPTION_SAGA, REDEMPTION_STORE, CASINO_ADAPTERS],
    };
  }
}
