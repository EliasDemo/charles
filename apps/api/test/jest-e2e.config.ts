import type { Config } from 'jest';

/** Pruebas e2e: contra PostgreSQL y Redis reales (docker compose up -d). */
const config: Config = {
  rootDir: '..',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  setupFiles: ['<rootDir>/test/support/load-test-env.ts'],
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  testTimeout: 30_000,
};

export default config;
