// BFF configuration. Server-side only, read at request time from the runtime env, so one image serves any
// environment (the same rule as `shared/config/runtime`). Nothing here is ever sent to the browser.

export interface BffConfig {
  /** Internal base URLs of the services the BFF calls. No trailing slash. */
  identityUrl: string;
  paymentsUrl: string;
  engagementUrl: string;
  /** Sandbox casino (compose network only). Empty: the sandbox routes answer 501. */
  casinoSimUrl: string;
  /** The wheel the widget shows. No service tells the web which wheel is active (known gap G-3). */
  wheelId: string;
  /** Casino platform the sandbox deposit simulates (`casino-a` | `casino-b`). */
  casinoPath: string;
  /** Sandbox deposit target: the engagement ingest URL of the demo tenant, its signing secret, its player. */
  sandboxTargetUrl: string;
  sandboxSecret: string;
  sandboxPlayerId: string;
  /** `Secure` on the session cookie. Off only for plain-http local dev. */
  secureCookie: boolean;
}

const trim = (s: string) => s.replace(/\/+$/, '');

export function readBffConfig(env: Record<string, string | undefined> = process.env): BffConfig {
  return {
    identityUrl: trim(env.IDENTITY_URL ?? 'http://identity:4001'),
    paymentsUrl: trim(env.PAYMENTS_URL ?? 'http://payments:4003'),
    engagementUrl: trim(env.ENGAGEMENT_URL ?? 'http://engagement:4002'),
    casinoSimUrl: trim(env.CASINO_SIM_URL ?? ''),
    wheelId: env.MIO_WHEEL_ID ?? '',
    casinoPath: env.MIO_SANDBOX_CASINO ?? 'casino-a',
    sandboxTargetUrl: env.MIO_SANDBOX_TARGET_URL ?? '',
    sandboxSecret: env.MIO_SANDBOX_SECRET ?? '',
    sandboxPlayerId: env.MIO_SANDBOX_PLAYER_ID ?? '',
    secureCookie: env.NODE_ENV === 'production' && env.MIO_INSECURE_COOKIE !== '1',
  };
}
