import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EntitlementsService } from './entitlements.service';

export interface EnforcementResult {
  barbersSuspended: number;
  barbersRestored: number;
  photosHidden: number;
  photosRestored: number;
}

/**
 * Aplica los límites del plan vigente a lo que la barbería ya tiene (Fase 15, modo completo):
 *
 * - **Al bajar de plan:** lo que excede queda inactivo, **nunca se borra**. Barberos: siguen los
 *   más antiguos (el dueño puede elegir otros); los demás dejan de recibir reservas nuevas, pero
 *   sus reservas ya hechas se mantienen. Fotos: se ocultan las más nuevas de la galería.
 * - **Al subir de plan:** se reactiva lo que el plan anterior había dejado inactivo, hasta el
 *   nuevo límite.
 */
@Injectable()
export class PlanEnforcementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async apply(barbershopId: string, actorId: string | null = null): Promise<EnforcementResult> {
    this.entitlements.invalidate(barbershopId);
    const [barberLimit, photoLimit] = await Promise.all([
      this.entitlements.limit(barbershopId, 'barbers'),
      this.entitlements.limit(barbershopId, 'gallery_photos'),
    ]);
    const now = new Date(this.clock.now());
    const result: EnforcementResult = {
      barbersSuspended: 0,
      barbersRestored: 0,
      photosHidden: 0,
      photosRestored: 0,
    };

    await this.prisma.$transaction(async (tx) => {
      // ── Barberos ──
      const active = await tx.barber.findMany({
        where: { barbershopId, deletedAt: null, endedAt: null, isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (barberLimit !== null && active.length > barberLimit) {
        const extra = active.slice(barberLimit).map((b) => b.id);
        const { count } = await tx.barber.updateMany({
          where: { id: { in: extra } },
          data: { isActive: false, planSuspendedAt: now },
        });
        result.barbersSuspended = count;
      } else {
        const room = barberLimit === null ? Number.MAX_SAFE_INTEGER : barberLimit - active.length;
        if (room > 0) {
          const suspended = await tx.barber.findMany({
            where: { barbershopId, deletedAt: null, endedAt: null, planSuspendedAt: { not: null } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: Math.min(room, 1000),
            select: { id: true },
          });
          if (suspended.length > 0) {
            const { count } = await tx.barber.updateMany({
              where: { id: { in: suspended.map((b) => b.id) } },
              data: { isActive: true, planSuspendedAt: null },
            });
            result.barbersRestored = count;
          }
        }
      }

      // ── Fotos de la galería de la barbería ──
      const visible = await tx.image.findMany({
        where: {
          barbershopId,
          kind: 'GALLERY',
          deletedAt: null,
          removedAt: null,
          planHiddenAt: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (photoLimit !== null && visible.length > photoLimit) {
        const { count } = await tx.image.updateMany({
          where: { id: { in: visible.slice(photoLimit).map((i) => i.id) } },
          data: { planHiddenAt: now, pinnedAt: null },
        });
        result.photosHidden = count;
      } else {
        const room = photoLimit === null ? Number.MAX_SAFE_INTEGER : photoLimit - visible.length;
        if (room > 0) {
          const hidden = await tx.image.findMany({
            where: { barbershopId, kind: 'GALLERY', deletedAt: null, planHiddenAt: { not: null } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: Math.min(room, 1000),
            select: { id: true },
          });
          if (hidden.length > 0) {
            const { count } = await tx.image.updateMany({
              where: { id: { in: hidden.map((i) => i.id) } },
              data: { planHiddenAt: null },
            });
            result.photosRestored = count;
          }
        }
      }

      if (Object.values(result).some((v) => v > 0)) {
        await this.audit.record(
          {
            actorId,
            action: 'plan.limits_applied',
            entityType: 'barbershop',
            entityId: barbershopId,
            changes: { ...result },
          },
          tx,
        );
      }
    });
    return result;
  }

  /**
   * El dueño elige qué barberos siguen activos (dentro del límite). Los no elegidos que estaban
   * activos quedan inactivos por el plan; los elegidos que el plan había suspendido se reactivan.
   */
  async chooseActiveBarbers(
    barbershopId: string,
    barberIds: string[],
    actorId: string,
  ): Promise<void> {
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      const chosen = new Set(barberIds);
      const candidates = await tx.barber.findMany({
        where: {
          barbershopId,
          deletedAt: null,
          endedAt: null,
          OR: [{ isActive: true }, { planSuspendedAt: { not: null } }],
        },
        select: { id: true, isActive: true },
      });
      const off = candidates.filter((b) => b.isActive && !chosen.has(b.id)).map((b) => b.id);
      const on = candidates.filter((b) => !b.isActive && chosen.has(b.id)).map((b) => b.id);
      if (off.length > 0) {
        await tx.barber.updateMany({
          where: { id: { in: off } },
          data: { isActive: false, planSuspendedAt: now },
        });
      }
      if (on.length > 0) {
        await tx.barber.updateMany({
          where: { id: { in: on } },
          data: { isActive: true, planSuspendedAt: null },
        });
      }
      await this.audit.record(
        {
          actorId,
          action: 'plan.active_barbers_chosen',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: { activated: on, suspended: off },
        },
        tx,
      );
    });
  }
}
