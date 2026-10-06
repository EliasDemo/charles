import { runDevTool } from './dev-cli';
import { devPay } from './dev-tools';

/**
 * Solo desarrollo: `pnpm --filter api dev:pay <bookingId> [--reject]`.
 * Simula el resultado del pago de una reserva pendiente por el mismo camino que el aviso real.
 */
const [bookingId, flag] = process.argv.slice(2);
if (!bookingId || (flag && flag !== '--reject')) {
  console.error('Uso: pnpm --filter api dev:pay <bookingId> [--reject]');
  process.exit(1);
}
void runDevTool(async (app) => {
  const result = await devPay(app, bookingId, flag === '--reject' ? 'REJECTED' : 'SUCCEEDED');
  console.warn(
    `Pago ${result.paymentId}: ${flag === '--reject' ? 'rechazado' : 'confirmado'}. ` +
      `Reserva ${bookingId}: ${result.bookingStatus}.`,
  );
});
