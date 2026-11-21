/*
 * Layering for a service (apps/<service>/src):
 *
 *   controllers/  HTTP in/out. Validates every input with zod (parseInput) and
 *                 calls services. Never touches model/ or the database driver.
 *   services/     Application logic only. Calls model/ for anything about data;
 *                 never imports the HTTP layer or the database driver.
 *   model/        Entities, repositories, migrations, the transaction wrapper.
 *                 Never imports controllers/ or services/.
 *
 * Direction: controllers -> services -> model. These rules turn a violation into
 * a lint error, so the layering does not depend on review. (Between packages,
 * the @nx/enforce-module-boundaries rule in the root config does the same.)
 */
const DRIVERS = [
  { name: 'typeorm', message: 'Database access belongs in src/model.' },
  { name: 'pg', message: 'Database access belongs in src/model.' },
  { name: 'ioredis', message: 'Redis access belongs behind the facade in @ex-mio/service-kit.' },
  { name: 'amqplib', message: 'Broker access belongs in src/messaging via @ex-mio/bus.' },
];

const DRIVER_PATTERNS = [
  { group: ['typeorm/*'], message: 'Database access belongs in src/model.' },
];

module.exports = {
  extends: ['./.eslintrc.cjs'],
  env: { node: true, jest: true },
  ignorePatterns: ['dist', 'coverage', 'node_modules'],
  rules: {
    // Nest resolves constructor dependencies from emitted decorator metadata; a
    // type-only import of an injected class would erase it and break injection.
    '@typescript-eslint/consistent-type-imports': 'off',
  },
  overrides: [
    {
      files: ['src/controllers/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: DRIVERS,
            patterns: [
              ...DRIVER_PATTERNS,
              {
                group: ['**/model', '**/model/*', '**/model/**'],
                message: 'Controllers call services, not the model.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/services/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              ...DRIVERS,
              { name: '@nestjs/platform-fastify', message: 'Services know nothing about HTTP.' },
            ],
            patterns: [
              ...DRIVER_PATTERNS,
              {
                group: ['**/controllers', '**/controllers/*', '**/controllers/**'],
                message: 'Services must not import the HTTP layer.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/model/**/*.ts'],
      excludedFiles: ['**/*.test.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/controllers', '**/controllers/*', '**/controllers/**'],
                message: 'The model must not import the HTTP layer.',
              },
              {
                group: ['**/services', '**/services/*', '**/services/**'],
                message: 'The model must not import services.',
              },
            ],
          },
        ],
      },
    },
  ],
};
