/**
 * Comprobaciones previas al arranque de la app real (`main.ts`). Las pruebas no pasan por aquí:
 * usan `createTestApp`.
 *
 * Con NODE_ENV=test no se aplican las reglas de producción (y no se lee el archivo .env). Ninguna
 * instancia real puede arrancar así.
 */
export function assertRunnableEnvironment(nodeEnv: string | undefined): void {
  if (nodeEnv === 'test') {
    throw new Error(
      'NODE_ENV=test solo se permite en las pruebas automatizadas; la aplicación no arranca así.',
    );
  }
}
