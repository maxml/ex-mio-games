import { Module } from '@nestjs/common';
import { getCache } from '@ex-mio/service-kit';
import { usageKeySalt } from './config';
import { ModelModule } from './model/model.module';
import { BALANCE_CACHE, BalanceService } from './services/balance.service';
import { BillingService } from './services/billing.service';
import { PaymentsInboxHandler } from './services/inbox.handler';
import { LedgerService } from './services/ledger.service';
import { PAYMENT_PROVIDER } from './services/providers/payment-provider';
import { selectPaymentProvider } from './services/providers/select-provider';
import { ReconciliationService } from './services/reconciliation.service';
import { USAGE_KEY_SALT, UsageService } from './services/usage.service';

/**
 * The payments domain: ledger commands, balance read, reconciliation, usage metering, billing and the
 * spin inbox handler. No HTTP and no broker here; `createAppModule` adds both.
 */
@Module({
  imports: [ModelModule],
  providers: [
    { provide: BALANCE_CACHE, useFactory: () => getCache() },
    { provide: PAYMENT_PROVIDER, useFactory: () => selectPaymentProvider() },
    { provide: USAGE_KEY_SALT, useFactory: () => usageKeySalt() },
    LedgerService,
    BalanceService,
    ReconciliationService,
    UsageService,
    BillingService,
    PaymentsInboxHandler,
  ],
  exports: [
    LedgerService,
    BalanceService,
    ReconciliationService,
    UsageService,
    BillingService,
    PaymentsInboxHandler,
  ],
})
export class LedgerModule {}
