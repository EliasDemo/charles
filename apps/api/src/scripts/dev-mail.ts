import { runDevTool } from './dev-cli';
import { devMail } from './dev-tools';

/** Solo desarrollo: `pnpm --filter api dev:mail <correo>`. Correos simulados de ese destinatario. */
const [to] = process.argv.slice(2);
if (!to) {
  console.error('Uso: pnpm --filter api dev:mail <correo>');
  process.exit(1);
}
void runDevTool(async (app) => {
  const mails = await devMail(app, to);
  if (mails.length === 0) {
    console.warn('Sin correos para ese destinatario (el buzón simulado guarda 1 hora).');
    return;
  }
  for (const mail of mails) {
    console.warn(`\n[${mail.sentAt}] ${mail.category} — ${mail.subject}\n${mail.text}`);
  }
});
