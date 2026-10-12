import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { IzipayMode } from '../../../common/config/env.validation';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { UsersService } from '../../users/users.service';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payment-gateway';
import { ReconciliationService } from '../reconciliation';
import {
  type CheckoutPage,
  type CheckoutResult,
  doneUrl,
  escapeHtml,
  htmlPage,
  messagePage,
  redirectPage,
} from '../checkout-pages';
import { IZIPAY_CHECKOUT_ROUTE, IzipayGateway } from './izipay-gateway';

/**
 * Página de pago que la app abre en un WebView (Fase 8B). Carga el formulario web de Izipay en
 * modo `redirect` con tarjeta y Yape; al terminar, Izipay vuelve por POST a `return` y de ahí se
 * redirige a `done`, que la app detecta para cerrar la vista. **La reserva solo se confirma por la
 * notificación firmada o por la consulta a Izipay**, nunca por esta página.
 */
@Injectable()
export class IzipayCheckoutService {
  private readonly logger = new Logger(IzipayCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly reconciliation: ReconciliationService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get izipay(): IzipayGateway | null {
    return this.gateway instanceof IzipayGateway ? this.gateway : null;
  }

  async page(paymentId: string, expires: unknown, signature: unknown): Promise<CheckoutPage> {
    const izipay = this.izipay;
    if (!izipay || !izipay.isValidCheckoutLink(paymentId, expires, signature)) {
      return messagePage(404, 'Enlace no válido', 'Este enlace de pago no existe o ya venció.');
    }
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        booking: {
          select: {
            id: true,
            status: true,
            expiresAt: true,
            clientId: true,
            serviceNameSnapshot: true,
          },
        },
      },
    });
    const now = this.clock.now();
    if (
      !payment ||
      payment.status !== 'PENDING' ||
      !payment.providerPaymentId ||
      payment.booking.status !== 'PENDING_PAYMENT' ||
      !payment.booking.expiresAt ||
      payment.booking.expiresAt.getTime() <= now
    ) {
      return redirectPage(
        this.doneUrl(izipay, payment?.booking.id ?? null, paymentId, 'expired'),
        'Este pago ya no está disponible.',
      );
    }
    const [user, contact] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: payment.booking.clientId },
        select: { fullName: true },
      }),
      this.users.contact(payment.booking.clientId),
    ]);
    let session;
    try {
      // Token nuevo en cada carga (dura 15 min y es de un solo uso). Fuera de transacciones.
      session = await izipay.checkoutSession({
        orderNumber: payment.providerPaymentId,
        amount: payment.amount,
        currency: payment.currency,
      });
    } catch (error) {
      this.logger.warn({ err: (error as Error).name, paymentId }, 'Izipay no generó el token');
      return messagePage(
        502,
        'No pudimos abrir el pago',
        'El servicio de pagos no respondió. Vuelve a intentarlo en unos segundos.',
      );
    }
    const [firstName, ...rest] = (user?.fullName ?? 'Cliente Charles').trim().split(/\s+/);
    const returnUrl = (result: CheckoutResult) =>
      `${izipay.publicBaseUrl()}/api/v1/${IZIPAY_CHECKOUT_ROUTE}/return/${paymentId}?r=${result}`;
    const config = {
      transactionId: session.transactionId,
      action: 'pay',
      merchantCode: session.merchantCode,
      order: {
        orderNumber: session.orderNumber,
        currency: session.currency,
        amount: session.amount,
        payMethod: 'CARD,YAPE_CODE',
        processType: 'AT',
        merchantBuyerId: payment.booking.clientId,
        dateTimeTransaction: `${now}000`,
      },
      // Izipay exige estos datos. Charles no guarda la dirección del cliente: se envía una
      // genérica de Lima (pendiente de validar con Izipay, docs/pendientes-produccion.md).
      billing: {
        firstName: clip(firstName ?? 'Cliente', 50),
        lastName: clip(rest.join(' ') || 'Charles', 50),
        email: contact?.email ?? '',
        phoneNumber: (contact?.phone ?? '').replace(/\D/g, '').slice(-9) || '999999999',
        street: 'Lima',
        city: 'Lima',
        state: 'Lima',
        country: 'PE',
        postalCode: '15001',
        documentType: 'DNI',
        document: '',
      },
      urlIPN: session.urlIPN,
      render: {
        typeForm: 'redirect',
        redirectUrls: {
          onSuccess: returnUrl('success'),
          onError: returnUrl('error'),
          onCancel: returnUrl('cancel'),
        },
      },
      appearance: { language: 'ESP' },
    };
    const nonce = randomBytes(16).toString('base64');
    return {
      status: 200,
      csp: izipayCsp(nonce, session.scriptUrl),
      html: checkoutHtml({
        nonce,
        scriptUrl: session.scriptUrl,
        config,
        token: session.token,
        publicKey: session.publicKey,
        title: payment.booking.serviceNameSnapshot,
        testMode: session.mode === IzipayMode.Test,
      }),
    };
  }

  /**
   * Regreso del formulario (POST x-www-form-urlencoded). Si trae un resultado firmado, se
   * consulta a Izipay el estado del pedido (igual que la conciliación). Luego, a `done`.
   */
  async handleReturn(
    paymentId: string,
    result: unknown,
    body: Record<string, unknown>,
  ): Promise<string> {
    const izipay = this.izipay;
    const outcome: CheckoutResult =
      result === 'success' || result === 'error' || result === 'cancel' ? result : 'error';
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, bookingId: true, providerPaymentId: true },
    });
    if (!izipay || !payment) return this.doneUrl(izipay, null, paymentId, 'error');
    try {
      const ref = izipay.verifyEnvelope(body);
      if (ref.providerPaymentId === payment.providerPaymentId) {
        await this.reconciliation.checkPayment(payment.id);
      }
    } catch {
      // Sin firma válida (cancelado o sin datos): no se consulta; la notificación decide.
    }
    return this.doneUrl(izipay, payment.bookingId, paymentId, outcome);
  }

  private doneUrl(
    izipay: IzipayGateway | null,
    bookingId: string | null,
    paymentId: string,
    result: CheckoutResult,
  ): string {
    return doneUrl(izipay?.publicBaseUrl() ?? '', bookingId, paymentId, result);
  }
}

/** Permite solo el script de Izipay (y lo que carga desde sus dominios) y el propio con nonce. */
function izipayCsp(nonce: string, scriptUrl: string): string {
  const origin = new URL(scriptUrl).origin;
  const izipay = 'https://*.izipay.pe';
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${origin} ${izipay}`,
    `connect-src ${origin} ${izipay}`,
    `frame-src ${origin} ${izipay}`,
    `img-src 'self' data: https:`,
    `style-src 'unsafe-inline' ${origin} ${izipay}`,
    `font-src ${origin} ${izipay} data:`,
    `form-action 'self' ${origin} ${izipay}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function checkoutHtml(input: {
  nonce: string;
  scriptUrl: string;
  config: object;
  token: string;
  publicKey: string;
  title: string;
  testMode: boolean;
}): string {
  // JSON dentro de <script>: se escapan "<" para que nada cierre la etiqueta.
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  return htmlPage(
    'Pagar reserva',
    `<h1>${escapeHtml(input.title)}</h1>
${input.testMode ? '<p class="test">Modo de pruebas: no se cobra dinero real.</p>' : ''}
<div id="estado">Cargando el formulario de pago…</div>
<script nonce="${input.nonce}">
window.addEventListener('load', function () {
  var estado = document.getElementById('estado');
  try {
    var checkout = new Izipay({ config: ${json(input.config)} });
    checkout.LoadForm({ authorization: ${json(input.token)}, keyRSA: ${json(input.publicKey)} });
  } catch (e) {
    estado.textContent = 'No pudimos abrir el formulario de pago. Vuelve a Charles e inténtalo de nuevo.';
  }
});
</script>`,
    `<script src="${escapeHtml(input.scriptUrl)}" defer></script>`,
  );
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
