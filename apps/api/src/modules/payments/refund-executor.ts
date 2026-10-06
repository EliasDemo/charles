import { Injectable, type OnModuleInit } from '@nestjs/common';
import { IdempotentConsumerStore } from '../../common/outbox/idempotent-consumer';
import { OutboxDispatcher } from '../../common/outbox/outbox.dispatcher';
import { PaymentsService, REFUND_REQUESTED_EVENT } from './payments.service';

export const REFUND_EXECUTOR = 'payments.refund-executor';

/**
 * Consumidor del outbox que envía cada reembolso a la pasarela, fuera de la transacción que lo
 * creó. Idempotente por ID de evento; si la pasarela falla, lanza y el relay reintenta con espera.
 * La pasarela también recibe la clave de idempotencia del reembolso: un reenvío no duplica.
 */
@Injectable()
export class RefundExecutor implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly store: IdempotentConsumerStore,
    private readonly payments: PaymentsService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: REFUND_EXECUTOR,
      types: [REFUND_REQUESTED_EVENT],
      handle: async (message) => {
        const refundId = message.payload.refundId;
        if (typeof refundId !== 'string') return;
        await this.store.runOnce(REFUND_EXECUTOR, message.id, () =>
          this.payments.executeRefund(refundId),
        );
      },
    });
  }
}
