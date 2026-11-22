import type { ProviderSnapshot } from '@ex-mio/contracts';
import type {
  CardToken,
  PaymentProvider,
  ProviderSubscription,
  SubscribeInput,
  SubscribeResult,
  UsageReportCall,
} from './payment-provider';

export class NotConfiguredError extends Error {
  constructor(method: string) {
    super(`the stripe provider is not implemented yet (${method})`);
    this.name = 'NotConfiguredError';
  }
}

/**
 * A stub behind configuration: selected only when `STRIPE_SECRET_KEY` is set, and every method throws
 * `NotConfiguredError`. The real adapter replaces the bodies, not the port. This is the only file
 * that may name the provider's SDK.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly kind = 'stripe';

  constructor(private readonly options: { secretKey: string }) {}

  tokenize(_card: string): CardToken {
    throw new NotConfiguredError('tokenize');
  }
  async createCustomer(_input: {
    tenantId: string;
    email: string;
  }): Promise<{ customerId: string }> {
    throw new NotConfiguredError('createCustomer');
  }
  async subscribe(_input: SubscribeInput): Promise<SubscribeResult> {
    throw new NotConfiguredError('subscribe');
  }
  verifyWebhook(_rawBody: string, _signature: string | undefined): ProviderSnapshot {
    throw new NotConfiguredError('verifyWebhook');
  }
  async getSubscription(_subscriptionId: string): Promise<ProviderSubscription> {
    throw new NotConfiguredError('getSubscription');
  }
  async cancelSubscription(_subscriptionId: string): Promise<void> {
    throw new NotConfiguredError('cancelSubscription');
  }
  async reportUsage(_call: UsageReportCall): Promise<{ recorded: boolean }> {
    throw new NotConfiguredError('reportUsage');
  }
}
