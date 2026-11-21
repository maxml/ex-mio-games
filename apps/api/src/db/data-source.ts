import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Column,
  CreateDateColumn,
  DataSource,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  type DataSourceOptions,
} from 'typeorm';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  name!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

// The entities the runtime repositories and the migrations both operate on.
const entities = [UserEntity];

// Resolve the migrations next to this file regardless of the working directory:
// `.ts` when loaded through ts-node (dev + the typeorm CLI), `.js` when run from
// the compiled `dist` in production (`node dist/index.js`).
const migrationsExtension = __filename.endsWith('.ts') ? 'ts' : 'js';
const migrations = [join(__dirname, '..', 'migrations', `*.${migrationsExtension}`)];

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities,
  migrations,
  // Dev bootstraps the schema straight from the entities. Production never
  // auto-syncs — it ships the versioned migrations and applies any pending ones
  // automatically the moment the DataSource initialises (migrationsRun), so a
  // clean production database gets its tables on first boot.
  synchronize: process.env.NODE_ENV !== 'production',
  migrationsRun: process.env.NODE_ENV === 'production',
  ssl: createPostgresSslOptions(),
};

// A single shared DataSource: ./index drives the runtime through it, and the
// typeorm CLI loads it directly for the migration:* scripts.
export const AppDataSource = new DataSource(dataSourceOptions);

function createPostgresSslOptions():
  | false
  | {
      rejectUnauthorized: boolean;
      ca?: string;
      cert?: string;
    } {
  if (process.env.NODE_ENV !== 'production') {
    return false;
  }

  const sslMode = process.env.DATABASE_SSL_MODE ?? 'require';
  const options: { rejectUnauthorized: boolean; ca?: string; cert?: string } = {
    rejectUnauthorized: sslMode !== 'require',
  };

  if (process.env.DATABASE_CA_CERT_PATH) {
    options.ca = readFileSync(process.env.DATABASE_CA_CERT_PATH, 'utf-8');
  }

  if (process.env.DATABASE_CLIENT_CERT_PATH) {
    options.cert = readFileSync(process.env.DATABASE_CLIENT_CERT_PATH, 'utf-8');
  }

  return options;
}
