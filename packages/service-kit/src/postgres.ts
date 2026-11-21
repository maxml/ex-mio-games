import { readFileSync } from 'node:fs';
import { DataSource, type DataSourceOptions } from 'typeorm';

export type PostgresSslMode = 'disable' | 'require' | 'verify-full';

export interface PostgresSsl {
  rejectUnauthorized: boolean;
  ca?: string;
}

/**
 * Decide the TLS mode for the Postgres connection.
 *
 * `DATABASE_SSL` is the switch: `disable`, `require` (encrypted, certificate not
 * verified: fits a self-signed server) or `verify-full` (encrypted and verified;
 * optional `DATABASE_CA_CERT_PATH`). When it is unset, a `sslmode` in the URL is
 * honoured for compatibility. Outside production the default is `disable`, so a
 * local database without TLS just works. In production there is NO default: the
 * operator must state the mode, so TLS is never off by accident. A self-hosted
 * Postgres without TLS says so explicitly with `DATABASE_SSL=disable`.
 */
export function resolvePostgresSslMode(env: NodeJS.ProcessEnv): PostgresSslMode {
  const explicit = env.DATABASE_SSL?.trim().toLowerCase();
  if (explicit) {
    if (explicit === 'disable' || explicit === 'require' || explicit === 'verify-full')
      return explicit;
    throw new Error(`DATABASE_SSL must be disable, require or verify-full (got "${explicit}")`);
  }
  const fromUrl = sslModeFromUrl(env.DATABASE_URL ?? '');
  if (fromUrl) return fromUrl;
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'DATABASE_SSL is required in production: set disable, require or verify-full (disable only for a database without TLS)',
    );
  }
  return 'disable';
}

function sslModeFromUrl(value: string): PostgresSslMode | undefined {
  try {
    const mode = new URL(value).searchParams.get('sslmode')?.toLowerCase();
    if (mode === 'disable') return 'disable';
    if (mode === 'require' || mode === 'prefer' || mode === 'allow')
      return mode === 'require' ? 'require' : 'disable';
    if (mode === 'verify-ca' || mode === 'verify-full') return 'verify-full';
  } catch {
    /* not a URL: the caller reports DATABASE_URL separately */
  }
  return undefined;
}

export function resolvePostgresSsl(env: NodeJS.ProcessEnv): false | PostgresSsl {
  const mode = resolvePostgresSslMode(env);
  if (mode === 'disable') return false;
  const ssl: PostgresSsl = { rejectUnauthorized: mode === 'verify-full' };
  if (env.DATABASE_CA_CERT_PATH) ssl.ca = readFileSync(env.DATABASE_CA_CERT_PATH, 'utf-8');
  return ssl;
}

/** The URL without `sslmode`, so the explicit `ssl` option is the only TLS input pg sees. */
export function stripSslMode(value: string): string {
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  return url.toString();
}

export interface DataSourceInput {
  env?: NodeJS.ProcessEnv;
  entities: NonNullable<DataSourceOptions['entities']>;
  /** Glob of compiled or source migration files. */
  migrations: string[];
}

/**
 * TypeORM options shared by every service: the same options serve the running
 * app and the one-off migration process. `synchronize` is always off: the schema
 * is whatever the migrations say, in every environment. `migrationsRun` is off
 * too: migrations are applied by `node dist/migrate.js` as a separate step,
 * never as a side effect of the app booting.
 */
export function buildDataSourceOptions(input: DataSourceInput): DataSourceOptions {
  const env = input.env ?? process.env;
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return {
    type: 'postgres',
    url: stripSslMode(url),
    ssl: resolvePostgresSsl(env),
    entities: input.entities,
    migrations: input.migrations,
    synchronize: false,
    migrationsRun: false,
  };
}

export function createDataSource(input: DataSourceInput): DataSource {
  return new DataSource(buildDataSourceOptions(input));
}
