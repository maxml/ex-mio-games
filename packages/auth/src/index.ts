export interface AuthUser {
  id: string;
  email?: string;
  name?: string | null;
  provider: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
  expiresAt: Date;
  redirectOrigin?: string;
}

export interface PasswordRegistrationInput {
  email: string;
  password: string;
  name?: string;
}

export interface PasswordLoginInput {
  email: string;
  password: string;
}

/** Provider-agnostic auth facade consumed by the API layer. */
export interface AuthService {
  verifyToken(token: string): Promise<AuthUser | null>;
  registerWithPassword?(input: PasswordRegistrationInput): Promise<AuthSession>;
  loginWithPassword?(input: PasswordLoginInput): Promise<AuthSession | null>;
  logout?(token: string): Promise<void>;
  createGoogleAuthorizationUrl?(input: { redirectOrigin?: string }): Promise<{
    authorizationUrl: string;
    stateVerifier: string;
  }>;
  completeGoogleOAuth?(input: {
    code: string;
    state: string;
    stateVerifier: string;
  }): Promise<AuthSession>;
}

const OAUTH_STATE_COOKIE = 'oauth_state_verifier';
const OAUTH_STATE_COOKIE_TTL_SECONDS = 10 * 60;

export function getBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim() || null;
}

export function getOAuthStateVerifier(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== OAUTH_STATE_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function createOAuthStateCookie(stateVerifier: string): string {
  return serializeOAuthStateCookie(stateVerifier, OAUTH_STATE_COOKIE_TTL_SECONDS);
}

export function clearOAuthStateCookie(): string {
  return serializeOAuthStateCookie('', 0);
}

function serializeOAuthStateCookie(value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
