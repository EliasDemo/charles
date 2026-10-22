import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/** Estados de una membresía con la que se puede usar crédito (CANCELED: hasta el fin del periodo). */
const USABLE: ('ACTIVE' | 'PAST_DUE' | 'CANCELED')[] = ['ACTIVE', 'PAST_DUE', 'CANCELED'];

export const noCredits = (): AppException =>
  new AppException(
    ErrorCode.NO_MEMBERSHIP_CREDITS,
    'No tienes créditos disponibles en esta membresía.',
    HttpStatus.CONFLICT,
  );

export const notApplicable = (): AppException =>
  new AppException(
    ErrorCode.MEMBERSHIP_NOT_APPLICABLE,
    'Esta membresía no cubre este servicio o esta barbería.',
    HttpStatus.CONFLICT,
  );

/**
 * Usa un crédito (Fase 16), dentro de la transacción de la reserva o de la venta. Toma el lote que
 * vence primero (bloqueado para que dos usos simultáneos no gasten el mismo crédito).
 */
export async function consumeCredit(
  tx: Tx,
  input: {
    membershipId: string;
    barbershopId: string;
    /** Persona dueña de la membresía (reservas). Ventas del local: la del cliente del panel. */
    userId: string | null;
    serviceIds: string[];
    bookingId?: string;
    saleId?: string;
    now: number;
  },
): Promise<void> {
  const membership = await tx.membership.findFirst({
    where: {
      id: input.membershipId,
      barbershopId: input.barbershopId,
      ...(input.userId ? { userId: input.userId } : {}),
      status: { in: USABLE },
    },
    select: { id: true, membershipPlan: { select: { services: { select: { serviceId: true } } } } },
  });
  if (!membership) throw notApplicable();
  const covered = new Set(membership.membershipPlan.services.map((s) => s.serviceId));
  if (covered.size > 0 && input.serviceIds.some((id) => !covered.has(id))) throw notApplicable();
  const [lot] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM membership_credit_lots
     WHERE membership_id = ${membership.id}::uuid AND remaining > 0 AND expires_at > ${new Date(input.now)}
     ORDER BY expires_at, id
     LIMIT 1
     FOR UPDATE`;
  if (!lot) throw noCredits();
  await tx.membershipCreditLot.update({
    where: { id: lot.id },
    data: { remaining: { decrement: 1 } },
  });
  await tx.membershipCreditUse.create({
    data: { lotId: lot.id, bookingId: input.bookingId ?? null, saleId: input.saleId ?? null },
  });
}

/** Devuelve el crédito de una reserva cancelada o de una venta anulada (si el lote no venció). */
export async function restoreCredit(
  tx: Tx,
  target: { bookingId?: string; saleId?: string },
  now: number,
): Promise<boolean> {
  const use = await tx.membershipCreditUse.findFirst({
    where: {
      ...(target.bookingId ? { bookingId: target.bookingId } : { saleId: target.saleId }),
      restoredAt: null,
    },
    select: { id: true, lotId: true, lot: { select: { expiresAt: true } } },
  });
  if (!use) return false;
  await tx.membershipCreditUse.update({
    where: { id: use.id },
    data: { restoredAt: new Date(now) },
  });
  if (use.lot.expiresAt.getTime() <= now) return false;
  await tx.membershipCreditLot.update({
    where: { id: use.lotId },
    data: { remaining: { increment: 1 } },
  });
  return true;
}

/** Créditos disponibles (lotes vigentes). */
export async function creditBalance(
  db: Pick<Tx, 'membershipCreditLot'>,
  membershipId: string,
  now: number,
): Promise<number> {
  const agg = await db.membershipCreditLot.aggregate({
    where: { membershipId, expiresAt: { gt: new Date(now) } },
    _sum: { remaining: true },
  });
  return agg._sum.remaining ?? 0;
}
