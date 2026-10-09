import type { Config } from 'jest';

/**
 * Cobertura de los módulos admin, support y account (Fase 12: soporte y operación; CLAUDE.md §11: mínimo 80 %),
 * medida con sus pruebas unitarias y las e2e contra la base real. Falla si baja del mínimo.
 * Misma base que jest-e2e.config.ts (Jest no permite importarla aquí sin extensión).
 * Compila sin `isolatedModules` (test/tsconfig.coverage.json): con él, TypeScript emite ramas
 * artificiales en los metadatos de los decoradores que no son lógica de la aplicación.
 */
const config: Config = {
  rootDir: '..',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testRegex: [
    'test/(admin|account)/.*\\.e2e-spec\\.ts$',
    // La revisión del alta (aprobar, pedir cambios, ver el documento) se prueba allí.
    'test/barbershops/review\\.e2e-spec\\.ts$',
    'src/modules/(admin|support|account)/.*\\.spec\\.ts$',
  ],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.coverage.json' }] },
  setupFiles: ['<rootDir>/test/support/load-test-env.ts'],
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  testTimeout: 30_000,
  collectCoverage: true,
  collectCoverageFrom: [
    'src/modules/admin/**/*.ts',
    'src/modules/support/**/*.ts',
    'src/modules/account/**/*.ts',
    '!**/*.spec.ts',
  ],
  coverageDirectory: '<rootDir>/coverage/admin',
  coverageReporters: ['text', 'text-summary'],
  coverageThreshold: {
    global: { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
};

export default config;
