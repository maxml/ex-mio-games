/**
 * The IdentityProvider port (spec 1.3). Provider types never leave the identity service: callers
 * get plain ids. Passwords live in the provider only. A failed call throws `ProviderError`, which
 * the services turn into PROVIDER_UNAVAILABLE.
 */
export interface IdentityProvider {
  /** One provider tenant per MIO tenant (D-7), so the same email can register in two tenants. */
  createTenant(displayName: string): Promise<{ providerTenantId: string }>;
  createUser(
    providerTenantId: string,
    input: { email: string; password: string },
  ): Promise<{ uid: string }>;
  /** `null` for a wrong password or an unknown email (the caller must not tell them apart). */
  verifyCredentials(
    providerTenantId: string,
    input: { email: string; password: string },
  ): Promise<{ uid: string } | null>;
  /** A passwordless player session for a verified launch: the provider-side subject of the player. */
  exchangeLaunchToken(
    providerTenantId: string,
    input: { userId: string; platform: string; externalPlayerId: string; existingUid?: string },
  ): Promise<{ uid: string }>;
  revokeSessions(providerTenantId: string, uid: string): Promise<void>;
  deleteUser(providerTenantId: string, uid: string): Promise<void>;
}

export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
