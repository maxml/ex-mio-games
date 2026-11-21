import { randomBytes } from 'node:crypto';
import { ProviderError } from '../errors';
import type { IdentityProvider } from './identity-provider';

export interface ProviderCall {
  method: keyof IdentityProvider;
  args: unknown[];
}

/** In-memory provider for tests: tenants keep their own accounts, so one email can live in two. */
export class FakeIdentityProvider implements IdentityProvider {
  readonly calls: ProviderCall[] = [];
  private readonly tenants = new Map<
    string,
    Map<string, { uid: string; password: string | null }>
  >();

  constructor(
    private readonly options: { down?: boolean; claims?: Record<string, unknown> } = {},
  ) {}

  /** Custom claims the provider "would" put in its own tokens; identity must never copy them. */
  get claims(): Record<string, unknown> | undefined {
    return this.options.claims;
  }

  private enter(method: keyof IdentityProvider, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.options.down) throw new ProviderError('identity provider unreachable');
  }

  private accounts(providerTenantId: string) {
    const a = this.tenants.get(providerTenantId);
    if (!a) throw new ProviderError('unknown provider tenant');
    return a;
  }

  async createTenant(displayName: string): Promise<{ providerTenantId: string }> {
    this.enter('createTenant', displayName);
    const id = `ptenant-${randomBytes(6).toString('hex')}`;
    this.tenants.set(id, new Map());
    return { providerTenantId: id };
  }

  async createUser(providerTenantId: string, input: { email: string; password: string }) {
    this.enter('createUser', providerTenantId, input.email);
    const accounts = this.accounts(providerTenantId);
    const key = input.email.toLowerCase();
    if (accounts.has(key)) throw new ProviderError('email exists', true);
    const uid = `fb_${randomBytes(10).toString('hex')}`;
    accounts.set(key, { uid, password: input.password });
    return { uid };
  }

  async verifyCredentials(providerTenantId: string, input: { email: string; password: string }) {
    this.enter('verifyCredentials', providerTenantId, input.email);
    const found = this.accounts(providerTenantId).get(input.email.toLowerCase());
    if (!found || found.password === null || found.password !== input.password) return null;
    return { uid: found.uid };
  }

  async revokeSessions(providerTenantId: string, uid: string): Promise<void> {
    this.enter('revokeSessions', providerTenantId, uid);
  }

  async deleteUser(providerTenantId: string, uid: string): Promise<void> {
    this.enter('deleteUser', providerTenantId, uid);
    const accounts = this.tenants.get(providerTenantId);
    if (!accounts) return;
    for (const [key, v] of accounts) if (v.uid === uid) accounts.delete(key);
  }
}
