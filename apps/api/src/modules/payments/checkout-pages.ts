import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator';

/**
 * Páginas HTML del pago que la app abre en un WebView (Izipay, Mercado Pago). Comunes a todas
 * las pasarelas: la final (`/payments/done`), que la app detecta para cerrar la vista, y las
 * utilidades para armarlas.
 */
export type CheckoutResult = 'success' | 'error' | 'cancel' | 'pending' | 'expired';

export interface CheckoutPage {
  status: number;
  html: string;
  /** Política de seguridad de contenido propia de la página. */
  csp: string;
}

/** La app cierra el WebView cuando navega a una URL que empieza con esto (tras la URL pública). */
export const PAYMENTS_DONE_PATH = '/api/v1/payments/done';

export const BASE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const DONE_TEXTS: Record<CheckoutResult, [string, string]> = {
  success: ['Pago enviado', 'Estamos confirmando tu reserva. Ya puedes volver a Charles.'],
  pending: [
    'Pago en proceso',
    'Tu pago está pendiente (por ejemplo, con Yape). Te avisaremos cuando se confirme.',
  ],
  error: ['El pago no se completó', 'Puedes volver a Charles e intentarlo de nuevo.'],
  cancel: ['Pago cancelado', 'No se realizó ningún cobro. Vuelve a Charles para continuar.'],
  expired: ['Este pago ya no está disponible', 'La reserva venció o ya fue pagada.'],
};

export function doneUrl(
  publicBaseUrl: string,
  bookingId: string | null,
  paymentId: string,
  result: CheckoutResult,
): string {
  const query = new URLSearchParams({ status: result, paymentId });
  if (bookingId) query.set('bookingId', bookingId);
  return `${publicBaseUrl}${PAYMENTS_DONE_PATH}?${query.toString()}`;
}

export function donePage(result: unknown): CheckoutPage {
  const key = (
    typeof result === 'string' && result in DONE_TEXTS ? result : 'error'
  ) as CheckoutResult;
  return messagePage(200, ...DONE_TEXTS[key]);
}

/** Página que lleva de inmediato a `url` (por ejemplo, a la final). */
export function redirectPage(url: string, text: string): CheckoutPage {
  return {
    status: 200,
    csp: BASE_CSP,
    html: htmlPage(
      'Redirigiendo',
      `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(url)}">Continuar</a></p>`,
      `<meta http-equiv="refresh" content="0;url=${escapeHtml(url)}">`,
    ),
  };
}

export function messagePage(status: number, title: string, text: string): CheckoutPage {
  return {
    status,
    csp: BASE_CSP,
    html: htmlPage(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`),
  };
}

export function htmlPage(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Charles</title>
<style>body{font-family:system-ui,sans-serif;margin:24px 16px;color:#1d1d1f}h1{font-size:20px}.test{background:#fff4ce;padding:8px;border-radius:6px}</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export function sendPage(res: Response, page: CheckoutPage): void {
  res
    .status(page.status)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .setHeader('Content-Security-Policy', page.csp)
    .setHeader('Cache-Control', 'no-store')
    .setHeader('Referrer-Policy', 'no-referrer')
    .send(page.html);
}

/** Página final del pago, común a todas las pasarelas. */
@ApiExcludeController()
@Controller('payments')
export class PaymentPagesController {
  @Public()
  @Get('done')
  done(@Query('status') status: unknown, @Res() res: Response): void {
    sendPage(res, donePage(status));
  }
}
