/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // Resolve the sibling workspace package to source so the log-line shape is
    // validated against the live LogLine schema without a prior build step.
    '^@ex-mio/contracts$': '<rootDir>/../contracts/src',
  },
  testTimeout: 60000,
  clearMocks: true,
};
