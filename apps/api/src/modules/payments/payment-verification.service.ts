import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { PaymentStatus } from '../../generated/prisma/enums';
import { PAYMENT_GATEWAY, type PaymentGateway, type RawWebhook } from './payment-gateway';
import { type ReconcileOutcome, ReconciliationService } from './reconciliation';

/**
 * Resultado que la app reenvía tras pagar (Izipay: `payloadHttp` y `signature`, clave hash).
 * Se verifica la firma, pero **nunca confirma por sí solo**: solo dispara la consulta del pago a
 * la pasarela, igual que la conciliación.
 */
@Injectable()
export class PaymentVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async verifyClientResult(
    clientId: string,
    bookingId: string,
    raw: RawWebhook,
  ): Promise<{ outcome: ReconcileOutcome; paymentStatus: PaymentStatus }> {
    const ref = this.gateway.verifyClientResult(raw);
    const payment = await this.prisma.payment.findFirst({
      where: {
        ...(ref.paymentId
          ? { id: ref.paymentId }
          : { provider: this.gateway.provider, providerPaymentId: ref.providerPaymentId ?? '' }),
        bookingId,
        booking: { clientId },
      },
      select: { id: true },
    });
    if (!payment) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El pago no existe.', HttpStatus.NOT_FOUND);
    }
    const outcome = await this.reconciliation.checkPayment(payment.id);
    const { status } = await this.prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { status: true },
    });
    return { outcome, paymentStatus: status };
  }
}
