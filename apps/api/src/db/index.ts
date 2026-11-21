import { QueryFailedError } from 'typeorm';
import type { CreateUserInput, User } from '@ex-mio/shared-types';
import { AppDataSource, UserEntity } from './data-source';

export { AppDataSource } from './data-source';

export class DuplicateUserError extends Error {
  constructor() {
    super('email already exists');
    this.name = 'DuplicateUserError';
  }
}

export interface AppDatabase {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<'ok' | 'down'>;
  listUsers(): Promise<User[]>;
  createUser(input: CreateUserInput): Promise<User>;
}

class TypeOrmPostgresDatabase implements AppDatabase {
  async connect(): Promise<void> {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
  }

  async disconnect(): Promise<void> {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }

  async ping(): Promise<'ok' | 'down'> {
    try {
      await this.connect();
      await AppDataSource.query('SELECT 1');
      return 'ok';
    } catch {
      return 'down';
    }
  }

  async listUsers(): Promise<User[]> {
    await this.connect();
    const users = await AppDataSource.getRepository(UserEntity).find({
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return users.map(toUser);
  }

  async createUser(input: CreateUserInput): Promise<User> {
    await this.connect();

    try {
      const repository = AppDataSource.getRepository(UserEntity);
      const created = repository.create({
        email: input.email,
        name: input.name ?? null,
      });
      return toUser(await repository.save(created));
    } catch (err: unknown) {
      if (isUniqueConstraintError(err)) {
        throw new DuplicateUserError();
      }
      throw err;
    }
  }
}

let database: AppDatabase | null = null;

export function getDatabase(): AppDatabase {
  database ??= new TypeOrmPostgresDatabase();
  return database;
}

export async function disconnectDatabase(): Promise<void> {
  if (!database) return;
  await database.disconnect();
  database = null;
}

function toUser(entity: UserEntity): User {
  return {
    id: entity.id,
    email: entity.email,
    name: entity.name,
    createdAt: entity.createdAt,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  return (err.driverError as { code?: string }).code === '23505';
}
