#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const root = process.cwd();
const pnpm = platform() === 'win32' ? 'pnpm.cmd' : 'pnpm';
const args = new Set(process.argv.slice(2));
const portRange = Number(process.env.DEV_STACK_PORT_RANGE ?? 50);
const lockDir = join(tmpdir(), 'dev-stack-port-locks');
const locks = [];
const children = new Set();

const stack = readStackConfig();
const composeProjectName = deriveComposeProjectName(root);

if (args.has('--down')) {
  stackDown();
} else {
  await stackUp();
}

async function stackUp() {
  const hasCompose = existsSync(join(root, 'docker-compose.yml'));
  const composeText = hasCompose ? readFileSync(join(root, 'docker-compose.yml'), 'utf8') : '';
  const ports = {};

  try {
    ports.web = await reservePort('web', 3000);
    ports.api = await reservePort('api', 4000);

    if (hasCompose) {
      if (stack.databaseProvider === 'prisma-mongo') {
        ports.mongo = await reservePort('mongo', 27017);
      } else {
        ports.postgres = await reservePort('postgres', 5432);
      }
      if (stack.redisEnabled && composeText.includes('redis:')) {
        ports.redis = await reservePort('redis', 6379);
      }
      if (composeText.includes('cloudbeaver:')) {
        ports.cloudbeaver = await reservePort('cloudbeaver', 8081);
      }
      if (composeText.includes('mongo-express:')) {
        ports.mongoExpress = await reservePort('mongo-express', 8081);
      }
      if (composeText.includes('minio/minio')) {
        ports.minio = await reservePort('minio-api', 9000);
        ports.minioConsole = await reservePort('minio-console', 9001);
      }
    }

    const databaseUrl = databaseUrlFor(stack, ports);
    const redisUrl = ports.redis ? `redis://localhost:${ports.redis}` : process.env.REDIS_URL;
    const apiUrl = `http://localhost:${ports.api}`;
    const webUrl = `http://localhost:${ports.web}`;
    const storageEnv = storageEnvFor(stack, ports);

    printPlan({ hasCompose, ports, databaseUrl, redisUrl, apiUrl, webUrl });

    if (hasCompose) {
      runChecked(
        'docker',
        ['compose', 'up', '-d', '--wait'],
        composeEnv(ports),
        'docker compose up failed',
      );
      if (databaseUrl) runDevMigration(stack, databaseUrl);
    } else {
      console.log('No docker-compose.yml found; skipping local infra.');
    }

    startApp('api', ['--filter', 'api', 'dev'], {
      PORT: String(ports.api),
      ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
      ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
      ...storageEnv,
      CORS_ORIGIN: webUrl,
    });
    startApp('web', ['--filter', 'web', 'dev'], {
      PORT: String(ports.web),
      NEXT_PUBLIC_API_URL: apiUrl,
    });
    if (existsSync(join(root, 'apps/worker/package.json')) && redisUrl) {
      startApp('worker', ['--filter', 'worker', 'dev'], {
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        REDIS_URL: redisUrl,
        ...storageEnv,
      });
    }

    installShutdownHandlers();
  } catch (error) {
    releaseLocks();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function stackDown() {
  if (!existsSync(join(root, 'docker-compose.yml'))) {
    console.log('No docker-compose.yml found; nothing to stop.');
    return;
  }
  runChecked(
    'docker',
    ['compose', '-p', composeProjectName, 'down'],
    composeEnv({}),
    'stack down failed',
  );
}

function readStackConfig() {
  const packageJson = readJson('package.json') ?? {};
  const scaffold = readJson('scaffold.config.json');
  return {
    packageName: scaffold?.project?.packageName ?? packageJson.name ?? basename(root),
    databaseProvider: scaffold?.database?.provider ?? inferDatabaseProvider(),
    redisEnabled: scaffold?.redis?.enabled ?? existsSync(join(root, 'apps/api/src/redis/index.ts')),
    storageEnabled:
      scaffold?.storage?.enabled ?? existsSync(join(root, 'apps/api/src/storage/index.ts')),
    storageDriver: scaffold?.storage?.driver ?? process.env.STORAGE_DRIVER ?? 'local',
  };
}

function inferDatabaseProvider() {
  const schemaPath = join(root, 'apps/api/prisma/schema.prisma');
  if (existsSync(schemaPath)) {
    const schema = readFileSync(schemaPath, 'utf8');
    if (schema.includes('provider = "mongodb"')) return 'prisma-mongo';
    return 'prisma-postgres';
  }
  if (existsSync(join(root, 'apps/api/src/db/data-source.ts'))) {
    return 'typeorm-postgres';
  }
  return 'prisma-postgres';
}

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
  } catch {
    return null;
  }
}

async function reservePort(label, preferred) {
  const used = new Set(Object.values(currentReservedPorts()));
  const max = preferred + portRange;
  for (let port = preferred; port <= max; port += 1) {
    if (used.has(port)) continue;
    const lock = acquirePortLock(port, label);
    if (!lock) continue;
    if (await canBind(port)) {
      locks.push(lock);
      used.add(port);
      return port;
    }
    releaseLock(lock);
  }
  throw new Error(`No free ${label} port in range ${preferred}..${max}.`);
}

function currentReservedPorts() {
  return Object.fromEntries(locks.map((lock) => [lock.label, lock.port]));
}

function acquirePortLock(port, label) {
  mkdirSync(lockDir, { recursive: true });
  const path = join(lockDir, `${port}.lock`);
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          cwd: root,
          label,
          port,
          createdAt: new Date().toISOString(),
        }),
      );
      closeSync(fd);
      return { path, port, label };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!removeStaleLock(path)) return null;
    }
  }
}

function removeStaleLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (Number.isInteger(value.pid) && processIsAlive(value.pid)) {
      return false;
    }
  } catch {
    // Corrupt lock files are treated as stale.
  }
  try {
    unlinkSync(path);
  } catch {
    return false;
  }
  return true;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLocks() {
  for (const lock of locks.splice(0)) releaseLock(lock);
}

function releaseLock(lock) {
  try {
    unlinkSync(lock.path);
  } catch {
    // Best effort; stale lock cleanup handles crashes.
  }
}

function canBind(port) {
  return new Promise((resolveBind) => {
    const server = net.createServer();
    server.once('error', () => resolveBind(false));
    server.listen({ host: '0.0.0.0', port }, () => {
      server.close(() => resolveBind(true));
    });
  });
}

function databaseUrlFor(config, ports) {
  const dbName = deriveDatabaseName(config.packageName);
  if (config.databaseProvider === 'prisma-mongo') {
    return ports.mongo
      ? `mongodb://localhost:${ports.mongo}/${dbName}?replicaSet=rs0&directConnection=true`
      : undefined;
  }
  return ports.postgres
    ? `postgresql://starter:starter@localhost:${ports.postgres}/${dbName}?sslmode=disable`
    : undefined;
}

function deriveDatabaseName(packageName) {
  return (
    packageName
      .replace(/^@/, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'app'
  );
}

function deriveComposeProjectName(cwd) {
  const name = sanitizeName(basename(cwd));
  const hash = createHash('sha1').update(resolve(cwd)).digest('hex').slice(0, 8);
  return `${name}-${hash}`;
}

function sanitizeName(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}

function composeEnv(ports) {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: composeProjectName,
    POSTGRES_PORT: String(ports.postgres ?? 5432),
    MONGO_PORT: String(ports.mongo ?? 27017),
    REDIS_PORT: String(ports.redis ?? 6379),
    CLOUDBEAVER_PORT: String(ports.cloudbeaver ?? 8081),
    MONGO_EXPRESS_PORT: String(ports.mongoExpress ?? 8081),
    MINIO_PORT: String(ports.minio ?? 9000),
    MINIO_CONSOLE_PORT: String(ports.minioConsole ?? 9001),
  };
}

function storageEnvFor(config, ports) {
  if (!config.storageEnabled || config.storageDriver !== 's3' || !ports.minio) {
    return {};
  }
  return {
    STORAGE_DRIVER: 's3',
    STORAGE_S3_ENDPOINT: `http://localhost:${ports.minio}`,
    STORAGE_S3_REGION: process.env.STORAGE_S3_REGION ?? 'us-east-1',
    STORAGE_S3_BUCKET: process.env.STORAGE_S3_BUCKET ?? 'uploads',
    STORAGE_S3_ACCESS_KEY_ID: process.env.STORAGE_S3_ACCESS_KEY_ID ?? 'minioadmin',
    STORAGE_S3_SECRET_ACCESS_KEY: process.env.STORAGE_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
  };
}

function runDevMigration(config, databaseUrl) {
  if (!existsSync(join(root, 'apps/api/package.json'))) return;
  const env = { ...process.env, DATABASE_URL: databaseUrl };
  if (config.databaseProvider === 'typeorm-postgres') {
    runChecked(pnpm, ['--filter', 'api', 'migration:run'], env, 'TypeORM migration failed');
    return;
  }
  runChecked(pnpm, ['--filter', 'api', 'prisma:push'], env, 'Prisma schema sync failed');
}

function startApp(label, pnpmArgs, env) {
  const child = spawn(pnpm, pnpmArgs, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      console.error(`${label} exited (${signal ?? code ?? 0}); stopping dev stack processes.`);
      shutdown(code ?? 1);
    }
  });
}

let shuttingDown = false;

function installShutdownHandlers() {
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', releaseLocks);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill('SIGTERM');
  }
  releaseLocks();
  setTimeout(() => process.exit(code), 250).unref();
}

function runChecked(command, commandArgs, env, failureMessage) {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env });
  if (result.status !== 0) {
    throw new Error(`${failureMessage} (${command} ${commandArgs.join(' ')})`);
  }
}

function printPlan({ hasCompose, ports, databaseUrl, redisUrl, apiUrl, webUrl }) {
  console.log(`Compose project: ${composeProjectName}`);
  console.log(`Web: ${webUrl}`);
  console.log(`API: ${apiUrl}`);
  if (databaseUrl) console.log(`Database: ${databaseUrl}`);
  if (redisUrl) console.log(`Redis: ${redisUrl}`);
  if (ports.cloudbeaver) console.log(`CloudBeaver: http://localhost:${ports.cloudbeaver}`);
  if (ports.mongoExpress) console.log(`Mongo Express: http://localhost:${ports.mongoExpress}`);
  if (ports.minio) console.log(`Minio API: http://localhost:${ports.minio}`);
  if (ports.minioConsole) console.log(`Minio console: http://localhost:${ports.minioConsole}`);
  if (!hasCompose) console.log('Infrastructure: skipped');
}
