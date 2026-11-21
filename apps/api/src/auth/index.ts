import {
  clearOAuthStateCookie,
  createOAuthStateCookie,
  getBearerToken,
  getOAuthStateVerifier,
} from '@ex-mio/auth';
import type { AuthService, AuthUser } from '@ex-mio/auth';

export { clearOAuthStateCookie, createOAuthStateCookie, getBearerToken, getOAuthStateVerifier };
export type { AuthService, AuthUser };

type FirebaseAuth = {
  verifyIdToken(token: string): Promise<unknown>;
};

class FirebaseAuthService implements AuthService {
  async verifyToken(token: string): Promise<AuthUser | null> {
    try {
      const auth = await getFirebaseAuth();
      return authUserFromDecodedToken(await auth.verifyIdToken(token));
    } catch {
      return null;
    }
  }
}

export function getAuthService(_database?: unknown): AuthService {
  return new FirebaseAuthService();
}

async function getFirebaseAuth(): Promise<FirebaseAuth> {
  const appModule = (await import('firebase-admin/app')) as unknown as {
    cert(serviceAccount: { projectId: string; clientEmail: string; privateKey: string }): unknown;
    getApps(): unknown[];
    initializeApp(options: { credential: unknown }): unknown;
  };
  const authModule = (await import('firebase-admin/auth')) as unknown as {
    getAuth(): FirebaseAuth;
  };

  if (appModule.getApps().length === 0) {
    appModule.initializeApp({
      credential: appModule.cert({
        projectId: process.env.FIREBASE_PROJECT_ID ?? 'replace-me',
        clientEmail:
          process.env.FIREBASE_CLIENT_EMAIL ?? 'firebase-adminsdk@example.iam.gserviceaccount.com',
        privateKey: (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      }),
    });
  }

  return authModule.getAuth();
}

function authUserFromDecodedToken(token: unknown): AuthUser | null {
  if (!isRecord(token)) return null;
  const id = stringProp(token, 'uid') ?? stringProp(token, 'sub');
  if (!id) return null;

  return {
    id,
    email: stringProp(token, 'email'),
    name: stringProp(token, 'name'),
    provider: 'firebase',
  };
}

function stringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
