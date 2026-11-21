const typeormImportRestriction = {
  name: 'typeorm',
  message: 'Import TypeORM only from the AppDatabase facade in apps/api/src/db.',
};
const typeormSubpathRestriction = {
  group: ['typeorm/*'],
  message: 'Import TypeORM only from the AppDatabase facade in apps/api/src/db.',
};

const redisImportRestriction = {
  name: 'ioredis',
  message:
    'Import Redis only from the Redis/Queue facades in apps/api/src/redis or apps/api/src/queue.',
};
const redisSubpathRestriction = {
  group: ['ioredis/*'],
  message:
    'Import Redis only from the Redis/Queue facades in apps/api/src/redis or apps/api/src/queue.',
};

module.exports = {
  extends: ['../../.eslintrc.cjs'],
  env: { node: true, jest: true },
  parserOptions: {
    project: false,
  },
  ignorePatterns: ['dist', 'coverage', 'node_modules'],
  overrides: [
    {
      files: ['src/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [typeormImportRestriction, redisImportRestriction],
            patterns: [typeormSubpathRestriction, redisSubpathRestriction],
          },
        ],
      },
    },
    {
      files: ['src/db/**/*.ts', 'src/redis/**/*.ts', 'src/queue/**/*.ts'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    {
      files: ['src/migrations/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [redisImportRestriction],
            patterns: [redisSubpathRestriction],
          },
        ],
      },
    },
  ],
};
