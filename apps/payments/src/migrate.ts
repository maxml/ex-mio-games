import 'dotenv/config';
import 'reflect-metadata';
import { runMigrationsCli } from '@ex-mio/service-kit';
import { makeMigrationDataSource } from './model/data-source';

// One-off entry point: `node dist/migrate.js`, run as the owner role. Exit 0 = applied, 1 = failed.
void runMigrationsCli(makeMigrationDataSource).then((code) => process.exit(code));
