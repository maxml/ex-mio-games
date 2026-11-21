import { randomBytes } from 'node:crypto';
import { FakePaymentProvider } from './fake.provider';
import type { PaymentProvider } from './payment-provider';
import { StripePaymentProvider } from './stripe.provider';

/** The shortest webhook secret a production process accepts. */
export const MIN_WEBHOOK_SECRET_LENGTH = 32;

/**
 * Choose the provider once, at start-up: `fake` unless `STRIPE_SECRET_KEY` is non-empty. This is the
 * only place the provider is chosen, and nothing else reads the environment for billing.
 *
 * The webhook secret of the fake provider comes from `FAKE_PROVIDER_WEBHOOK_SECRET` and from nowhere
 * else: there is no value written in the source (D-20). Production refuses to start without a secret
 * of at least 32 characters. Outside production a missing secret becomes a random one for this
 * process, so no webhook can be signed by anyone who has read the repository; a stack that needs to
 * sign webhooks sets the variable (compose does).
 */
export function selectPaymentProvider(
  env: Record<string, string | undefined> = process.env,
): PaymentProvider {
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (stripeKey && stripeKey.length > 0) return new StripePaymentProvider({ secretKey: stripeKey });
  const configured = env.FAKE_PROVIDER_WEBHOOK_SECRET;
  if (env.NODE_ENV === 'production') {
    if (!configured || configured.length < MIN_WEBHOOK_SECRET_LENGTH) {
      throw new Error(
        `FAKE_PROVIDER_WEBHOOK_SECRET is required in production (at least ${MIN_WEBHOOK_SECRET_LENGTH} characters)`,
      );
    }
    return new FakePaymentProvider({ webhookSecret: configured });
  }
  return new FakePaymentProvider({
    webhookSecret: configured || randomBytes(32).toString('hex'),
  });
}
