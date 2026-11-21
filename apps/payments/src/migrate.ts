import 'dotenv/config';
import 'reflect-metadata';
import { runMigrationsCli } from '@ex-mio/service-kit';
import { makeDataSource } from './model/data-source';

// One-off entry point: `node dist/migrate.js`. Exit 0 = applied, 1 = failed.
void runMigrationsCli(makeDataSource).then((code) => process.exit(code));
