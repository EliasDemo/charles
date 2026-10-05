import type { Config } from 'jest';

/** Pruebas unitarias: no tocan base de datos ni Redis. */
const config: Config = {
  rootDir: 'src',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
  collectCoverageFrom: ['**/*.ts', '!generated/**', '!main.ts', '!scripts/**'],
  coverageDirectory: '../coverage',
};

export default config;
