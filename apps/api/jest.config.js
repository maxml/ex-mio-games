/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@ex-mio/shared-types$': '<rootDir>/../../packages/shared-types/src',
    '^@ex-mio/logger$': '<rootDir>/../../packages/logger/src',
    '^@ex-mio/auth/custom$': '<rootDir>/../../packages/auth/src/custom',
    '^@ex-mio/auth$': '<rootDir>/../../packages/auth/src',
  },
  testTimeout: 60000,
  clearMocks: true,
};
