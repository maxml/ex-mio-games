import { ProviderError } from '../errors';
import type { IdentityProvider } from './identity-provider';

/** The parts of the emulator's JSON answers this adapter reads. */
type EmulatorJson = { error?: { message?: unknown }; [field: string]: unknown };

/**
 * Adapter for the Firebase Auth Emulator (demo project, default in compose). It uses Identity
 * Platform multi-tenancy: one provider tenant per MIO tenant, so the same email registers in two
 * tenants as two accounts with their own passwords (D-7). Speaks the emulator's REST API; no
 * Firebase SDK type crosses this file.
 */
export class FirebaseEmulatorProvider implements IdentityProvider {
  private readonly base: string;

  constructor(
    host: string,
    private readonly project: string,
  ) {
    this.base = `http://${host}/identitytoolkit.googleapis.com`;
  }

  private async call(path: string, body: unknown, admin = false): Promise<EmulatorJson> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // the emulator accepts this fixed owner token for admin endpoints
          ...(admin ? { authorization: 'Bearer owner' } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new ProviderError(`emulator unreachable: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as EmulatorJson;
    if (!res.ok) {
      const message = String(json?.error?.message ?? res.status);
      throw new ProviderError(message, message.startsWith('EMAIL_EXISTS'));
    }
    return json;
  }

  async createTenant(displayName: string): Promise<{ providerTenantId: string }> {
    // Identity Platform: 4-20 characters, letters, digits and hyphens, starting with a letter.
    const name =
      `t-${displayName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}${Math.random().toString(36).slice(2, 6)}`.slice(
        0,
        20,
      );
    const json = await this.call(
      `/v2/projects/${this.project}/tenants`,
      { displayName: name, allowPasswordSignup: true, enableEmailLinkSignin: false },
      true,
    );
    const id = String(json.name ?? '')
      .split('/')
      .pop();
    if (!id) throw new ProviderError('emulator returned no tenant id');
    return { providerTenantId: id };
  }

  async createUser(providerTenantId: string, input: { email: string; password: string }) {
    const json = await this.call('/v1/accounts:signUp?key=fake-api-key', {
      email: input.email,
      password: input.password,
      tenantId: providerTenantId,
      returnSecureToken: false,
    });
    return { uid: String(json.localId) };
  }

  async verifyCredentials(providerTenantId: string, input: { email: string; password: string }) {
    try {
      const json = await this.call('/v1/accounts:signInWithPassword?key=fake-api-key', {
        email: input.email,
        password: input.password,
        tenantId: providerTenantId,
        returnSecureToken: true,
      });
      return { uid: String(json.localId) };
    } catch (err) {
      if (
        err instanceof ProviderError &&
        /INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/.test(err.message)
      ) {
        return null;
      }
      throw err;
    }
  }

  async exchangeLaunchToken(
    providerTenantId: string,
    input: { userId: string; platform: string; externalPlayerId: string; existingUid?: string },
  ) {
    // D-21: a player is identified by the casino launch token only and gets our own JWT. No account
    // is created in the provider (the emulator refuses anonymous sign-up in a tenant anyway), so
    // this is a local subject and makes no network call.
    void providerTenantId;
    return { uid: input.existingUid ?? `player:${input.userId}` };
  }

  async revokeSessions(providerTenantId: string, uid: string): Promise<void> {
    await this.call(
      `/v1/projects/${this.project}/accounts:update`,
      {
        localId: uid,
        tenantId: providerTenantId,
        validSince: String(Math.floor(Date.now() / 1000)),
      },
      true,
    );
  }

  async deleteUser(providerTenantId: string, uid: string): Promise<void> {
    await this.call(
      `/v1/projects/${this.project}/accounts:delete`,
      { localId: uid, tenantId: providerTenantId },
      true,
    );
  }
}
