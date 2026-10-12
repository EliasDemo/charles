import { runDevTool } from './dev-cli';
import { devBooking, parseOffset } from './dev-tools';

/**
 * Solo desarrollo. Con una pasarela real (PAYMENTS_GATEWAY=mercadopago) imprime el enlace de pago.
 *
 * `pnpm --filter api dev:booking --barber <correo> [--start -20m] [--client <correo>]
 *  [--service <id>] [--confirm] [--attended]`
 */
const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const barberEmail = value('--barber');
if (!barberEmail) {
  console.error(
    'Uso: pnpm --filter api dev:booking --barber <correo> [--start -20m] [--client <correo>] ' +
      '[--service <id>] [--confirm] [--attended]',
  );
  process.exit(1);
}
void runDevTool(async (app) => {
  const result = await devBooking(app, {
    barberEmail,
    clientEmail: value('--client'),
    serviceId: value('--service'),
    startOffsetMinutes: parseOffset(value('--start') ?? '0'),
    confirm: args.includes('--confirm'),
    attended: args.includes('--attended'),
  });
  console.warn(
    `Reserva ${result.bookingId}: ${result.status}, inicio ${result.startAt.toISOString()} ` +
      `(barbería ${result.barbershopId}).`,
  );
  if (result.paymentUrl)
    console.warn(`Enlace de pago (ábrelo en el navegador):
${result.paymentUrl}`);
});
