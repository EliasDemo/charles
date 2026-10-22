import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import {
  BILLING_GATEWAY,
  type BillingGateway,
  type BillingReferenceKind,
  type BillingWebhookEvent,
  InvalidBillingSignatureError,
  parseBillingReference,
  type RawBillingWebhook,
} from './billing-gateway';

type Tx = Prisma.TransactionClient;
export type BillingSubscriptionEvent = Extract<BillingWebhookEvent, { kind: 'SUBSCRIPTION' }>;
export type BillingPaymentEvent = Extract<
  BillingWebhookEvent,
  { kind: 'SUBSCRIPTION_PAYMENT' | 'PAYMENT' }
>;

/**
 * Quien cobra algo con la pasarela de facturación (suscripciones, membresías, paquetes) recibe
 * aquí sus avisos. Corre **dentro** de la transacción que registra el aviso (idempotencia); los
 * efectos externos (pasarela, correo) van después, con `afterCommit`.
 */
export interface BillingHandler {
  onSubscription?(tx: Tx, id: string, event: BillingSubscriptionEvent): Promise<AfterCommit | void>;
  onPayment?(tx: Tx, id: string, event: BillingPaymentEvent): Promise<AfterCommit | void>;
}
export type AfterCommit = () => Promise<void>;

export interface BillingReceipt {
  received: true;
  duplicate: boolean;
}

/** Recepción de avisos de la pasarela de facturación: firma, idempotencia y reparto. */
@Injectable()
export class BillingWebhooksService {
  private readonly logger = new Logger(BillingWebhooksService.name);
  private readonly handlers = new Map<BillingReferenceKind, BillingHandler>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway,
  ) {}

  register(kind: BillingReferenceKind, handler: BillingHandler): void {
    this.handlers.set(kind, handler);
  }

  async receive(provider: string, raw: RawBillingWebhook): Promise<BillingReceipt> {
    if (provider.toUpperCase() !== this.gateway.provider) {
      throw new AppException(ErrorCode.NOT_FOUND, 'Proveedor desconocido.', HttpStatus.NOT_FOUND);
    }
    let event: BillingWebhookEvent;
    try {
      event = await this.gateway.parseWebhook(raw);
    } catch (error) {
      if (error instanceof InvalidBillingSignatureError) {
        this.logger.warn(`Aviso de facturación de ${provider} con firma inválida`);
        throw new AppException(
          ErrorCode.INVALID_SIGNATURE,
          'Firma inválida.',
          HttpStatus.UNAUTHORIZED,
        );
      }
      throw error;
    }
    return this.apply(event);
  }

  /** Aplica un aviso ya verificado (también lo usa la sincronización manual). */
  async apply(event: BillingWebhookEvent): Promise<BillingReceipt> {
    if (event.kind === 'IGNORED') return { received: true, duplicate: false };
    const ref = parseBillingReference(event.reference);
    const handler = ref ? this.handlers.get(ref.kind) : undefined;
    if (!ref || !handler) {
      this.logger.warn(`Aviso de facturación sin destino: ${event.providerEventId}`);
      return { received: true, duplicate: false };
    }
    let after: AfterCommit | void;
    try {
      after = await this.prisma.$transaction(async (tx) => {
        await tx.billingEvent.create({
          data: {
            provider: this.gateway.provider,
            providerEventId: event.providerEventId,
            kind: event.kind,
            payload: {
              reference: event.reference,
              ...('outcome' in event ? { outcome: event.outcome } : { status: event.status }),
            },
          },
        });
        return event.kind === 'SUBSCRIPTION'
          ? handler.onSubscription?.(tx, ref.id, event)
          : handler.onPayment?.(tx, ref.id, event);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { received: true, duplicate: true };
      }
      throw error;
    }
    if (after) {
      try {
        await after();
      } catch (error) {
        // El aviso ya quedó aplicado; el efecto externo lo reintenta el trabajo periódico.
        this.logger.warn(
          `Efecto posterior de ${event.providerEventId} falló: ${(error as Error).message}`,
        );
      }
    }
    return { received: true, duplicate: false };
  }
}
