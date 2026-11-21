import { FakePaymentProvider } from './fake.provider';
import type { PaymentProvider } from './payment-provider';
import { StripePaymentProvider } from './stripe.provider';

/** Local-development secret of the fake provider's webhook signatures. */
const DEV_WEBHOOK_SECRET = 'whsec_dev_fake_provider_secret';

/**
 * Choose the provider once, at start-up: `fake` unless `STRIPE_SECRET_KEY` is non-empty. This is the
 * only place the provider is chosen, and nothing else reads the environment for billing.
 */
export function selectPaymentProvider(
  env: Record<string, string | undefined> = process.env,
): PaymentProvider {
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (stripeKey && stripeKey.length > 0) return new StripePaymentProvider({ secretKey: stripeKey });
  return new FakePaymentProvider({
    webhookSecret: env.FAKE_PROVIDER_WEBHOOK_SECRET || DEV_WEBHOOK_SECRET,
  });
}
