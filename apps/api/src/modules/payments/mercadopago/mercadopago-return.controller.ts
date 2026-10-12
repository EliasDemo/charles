import { Controller, Get, Inject, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../../common/auth/public.decorator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { type CheckoutResult, doneUrl } from '../checkout-pages';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payment-gateway';
import { ReconciliationService } from '../reconciliation';
import { MERCADOPAGO_RETURN_ROUTE, MercadoPagoGateway } from './mercadopago-gateway';

const RESULTS: Record<string, CheckoutResult> = {
  success: 'success',
  pending: 'pending',
  failure: 'error',
};

/**
 * Regreso desde Checkout Pro (`back_urls`, GET). Lo que trae la URL no se cree: solo dispara la
 * consulta del pago a Mercado Pago (como la conciliación) y lleva a la página final.
 */
@ApiExcludeController()
@Controller(MERCADOPAGO_RETURN_ROUTE)
export class MercadoPagoReturnController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  @Public()
  @Get('return/:paymentId')
  async return(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Query('r') result: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const outcome: CheckoutResult =
      typeof result === 'string' && result in RESULTS ? RESULTS[result]! : 'error';
    const gateway = this.gateway instanceof MercadoPagoGateway ? this.gateway : null;
    const payment = gateway
      ? await this.prisma.payment.findUnique({
          where: { id: paymentId },
          select: { id: true, bookingId: true, provider: true },
        })
      : null;
    if (gateway && payment?.provider === gateway.provider && outcome !== 'error') {
      await this.reconciliation.checkPayment(payment.id);
    }
    res.redirect(
      303,
      doneUrl(gateway?.publicBaseUrl() ?? '', payment?.bookingId ?? null, paymentId, outcome),
    );
  }
}
