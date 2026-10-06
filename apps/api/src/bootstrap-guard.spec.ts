import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertRunnableEnvironment } from './bootstrap-guard';

describe('Arranque de la app real: sin vías para saltarse las validaciones de producción', () => {
  it('NODE_ENV=test no puede arrancar la app real (registraría el pago simulado)', () => {
    expect(() => assertRunnableEnvironment('test')).toThrow(/NODE_ENV=test/);
  });

  it.each(['production', 'development'])('NODE_ENV=%s sí arranca', (env) => {
    expect(() => assertRunnableEnvironment(env)).not.toThrow();
  });

  it('main.ts aplica la comprobación antes de crear la aplicación', () => {
    const main = readFileSync(resolve(__dirname, 'main.ts'), 'utf8');
    expect(main.indexOf('assertRunnableEnvironment(process.env.NODE_ENV)')).toBeGreaterThan(-1);
    expect(main.indexOf('assertRunnableEnvironment(process.env.NODE_ENV)')).toBeLessThan(
      main.indexOf('NestFactory.create'),
    );
  });

  it('el código de la app no tiene opciones para reemplazar proveedores ni omitir comprobaciones', () => {
    // `overrides` existe solo en test/support/create-test-app.ts.
    for (const file of ['main.ts', 'app.module.ts', 'configure-app.ts']) {
      const source = readFileSync(resolve(__dirname, file), 'utf8');
      expect(source).not.toMatch(/overrideProvider|overrides/);
    }
  });
});
