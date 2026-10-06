import type { Config } from 'jest';

/**
 * Prueba de carga de la carrera por un turno (RF-RES-007): `pnpm --filter api test:load:race`.
 * No forma parte de `pnpm verify`. Usa su propia base (charles_race, que crea al empezar y elimina
 * al terminar) y Redis (/3).
 * Variables: RACE_ROUNDS (por defecto 200), RACE_POOL_MAX (tamaño del pool).
 */
const config: Config = {
  rootDir: '..',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testRegex: 'test/load/.*\\.load-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  setupFiles: ['<rootDir>/test/load/race-env.ts'],
  globalSetup: '<rootDir>/test/load/race-global-setup.ts',
  globalTeardown: '<rootDir>/test/load/race-global-teardown.ts',
  testTimeout: 1_800_000,
};

export default config;
