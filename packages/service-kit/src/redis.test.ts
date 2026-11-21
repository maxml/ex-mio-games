import { checkRedisHealth, disconnectCache, getCache } from './redis';

// In-memory ioredis fake so the suite never needs a live Redis in CI.
jest.mock('ioredis', () => {
  class FakeRedis {
    private readonly store = new Map<string, string>();
    public quit = jest.fn(async () => 'OK');

    constructor(
      public readonly url: string,
      public readonly options?: unknown,
    ) {}

    on(): this {
      return this;
    }

    async get(key: string): Promise<string | null> {
      return this.store.has(key) ? (this.store.get(key) as string) : null;
    }

    async set(key: string, value: string): Promise<'OK'> {
      this.store.set(key, value);
      return 'OK';
    }

    async del(key: string): Promise<number> {
      return this.store.delete(key) ? 1 : 0;
    }

    async ping(): Promise<'PONG'> {
      return 'PONG';
    }
  }

  return { Redis: FakeRedis };
});

describe('redis facade', () => {
  afterEach(async () => {
    await disconnectCache();
    delete process.env.REDIS_URL;
  });

  it('returns null when REDIS_URL is unset so the app can run without Redis', () => {
    expect(getCache({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('memoizes a single client when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const first = getCache();
    const second = getCache();
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it('round-trips get/set/del through the facade', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const cache = getCache();
    expect(cache).not.toBeNull();

    await cache!.set('greeting', 'hello', 60);
    expect(await cache!.get('greeting')).toBe('hello');

    await cache!.del('greeting');
    expect(await cache!.get('greeting')).toBeNull();
  });

  it('exposes the raw client for pub/sub consumers', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const cache = getCache();
    expect(cache!.client()).toBeDefined();
  });

  describe('checkRedisHealth', () => {
    it('returns null (omitted from the report) when Redis is not configured', async () => {
      delete process.env.REDIS_URL;
      await disconnectCache();
      expect(await checkRedisHealth()).toBeNull();
    });

    it('reports ok with a latency when Redis answers PING', async () => {
      process.env.REDIS_URL = 'redis://localhost:6379';
      const health = await checkRedisHealth();
      expect(health).not.toBeNull();
      expect(health?.status).toBe('ok');
      expect(typeof health?.latencyMs).toBe('number');
    });
  });
});
