import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { barbershopMedia } from '../images/barbershop-media';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { MessagingService } from '../messaging/messaging.service';
import type { CreateJobOfferDto, JobOfferDto } from './dto/jobs.dto';

const DAY_MS = 86_400_000;
const offerInclude = {
  barbershop: {
    select: { id: true, name: true, address: true, ratingAvg: true, ratingCount: true },
  },
  barberProfile: { select: { id: true, userId: true, displayName: true } },
} satisfies Prisma.JobOfferInclude;
type OfferRow = Prisma.JobOfferGetPayload<{ include: typeof offerInclude }>;

export const JOB_OFFER_EVENTS = {
  CREATED: 'job.offer_created',
  ANSWERED: 'job.offer_answered',
} as const;

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La oferta no existe.', HttpStatus.NOT_FOUND);
const notPending = (): AppException =>
  new AppException(
    ErrorCode.INVALID_STATE_TRANSITION,
    'Esta oferta ya fue respondida, retirada o venció.',
    HttpStatus.CONFLICT,
  );

/**
 * Oferta directa de una barbería a un barbero (pedido de la app). Él la acepta (entra al equipo,
 * como al ser contratado en la bolsa de trabajo) o la rechaza. Vence a los N días sin respuesta.
 */
@Injectable()
export class JobOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly barbers: BarbersService,
    private readonly messaging: MessagingService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    actorId: string,
    barbershopId: string,
    dto: CreateJobOfferDto,
  ): Promise<JobOfferDto> {
    await this.access.requireMember(actorId, barbershopId);
    if (dto.payMin != null && dto.payMax != null && dto.payMin > dto.payMax) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'payMax', constraints: ['notBelowPayMin'] }],
      );
    }
    const profile = await this.prisma.barberProfile.findFirst({
      where: { id: dto.barberProfileId, deletedAt: null, user: { anonymizedAt: null } },
      select: { id: true, userId: true },
    });
    if (!profile) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);
    }
    const working = await this.prisma.barber.count({
      where: { barbershopId, userId: profile.userId, deletedAt: null, endedAt: null },
    });
    if (working) {
      throw new AppException(
        ErrorCode.BARBER_ALREADY_ACTIVE_ELSEWHERE,
        'Este barbero ya trabaja en tu barbería.',
        HttpStatus.CONFLICT,
      );
    }
    const now = this.clock.now();
    await this.expireStale();
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        const offer = await tx.jobOffer.create({
          data: {
            barbershopId,
            barberProfileId: profile.id,
            title: dto.title,
            message: dto.message ?? null,
            employmentType: dto.employmentType,
            payMin: dto.payMin ?? null,
            payMax: dto.payMax ?? null,
            payType: dto.payType ?? null,
            payPeriod: dto.payPeriod ?? null,
            schedule: dto.schedule ?? null,
            expiresAt: new Date(now + (dto.expiresInDays ?? 7) * DAY_MS),
            createdById: actorId,
          },
          select: { id: true },
        });
        await this.messaging.postSystem(tx, {
          barbershopId,
          userId: profile.userId,
          kind: 'PROFESSIONAL',
          body: `Te enviamos una oferta de trabajo: «${dto.title}». Revísala en «Ofertas» para aceptarla o rechazarla.`,
        });
        await this.outbox.publish(tx, JOB_OFFER_EVENTS.CREATED, { offerId: offer.id });
        await this.audit.record(
          {
            actorId,
            action: 'job_offer.created',
            entityType: 'job_offer',
            entityId: offer.id,
            changes: { barberProfileId: profile.id },
          },
          tx,
        );
        return offer.id;
      });
      return this.one(id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Ya le enviaste una oferta pendiente a este barbero.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async listForShop(actorId: string, barbershopId: string): Promise<JobOfferDto[]> {
    await this.access.requireMember(actorId, barbershopId);
    await this.expireStale();
    const rows = await this.prisma.jobOffer.findMany({
      where: { barbershopId },
      include: offerInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.toDtos(rows);
  }

  async withdraw(actorId: string, barbershopId: string, offerId: string): Promise<JobOfferDto> {
    await this.access.requireMember(actorId, barbershopId);
    const { count } = await this.prisma.jobOffer.updateMany({
      where: { id: offerId, barbershopId, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });
    if (!count) {
      if (!(await this.prisma.jobOffer.count({ where: { id: offerId, barbershopId } })))
        throw notFound();
      throw notPending();
    }
    return this.one(offerId);
  }

  /** Ofertas que recibió el barbero (su perfil profesional). */
  async mine(userId: string): Promise<JobOfferDto[]> {
    await this.expireStale();
    const rows = await this.prisma.jobOffer.findMany({
      where: { barberProfile: { userId } },
      include: offerInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.toDtos(rows);
  }

  async answer(
    userId: string,
    offerId: string,
    accept: boolean,
    note: string | undefined,
  ): Promise<JobOfferDto> {
    await this.expireStale();
    const now = new Date(this.clock.now());
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        {
          status: string;
          barbershop_id: string;
          user_id: string;
          display_name: string;
          created_by: string;
        }[]
      >`
        SELECT o.status::text AS status, o.barbershop_id::text AS barbershop_id, p.user_id::text AS user_id,
               p.display_name, o.created_by::text AS created_by
          FROM job_offers o JOIN barber_profiles p ON p.id = o.barber_profile_id
         WHERE o.id = ${offerId}::uuid FOR UPDATE OF o`;
      if (!row || row.user_id !== userId) throw notFound();
      if (row.status !== 'PENDING') throw notPending();
      await tx.jobOffer.update({
        where: { id: offerId },
        data: {
          status: accept ? 'ACCEPTED' : 'REJECTED',
          respondedAt: now,
          responseNote: note ?? null,
        },
      });
      if (accept) {
        // Entra al equipo como en la bolsa de trabajo (la barbería le asigna servicios después).
        await this.barbers.hireInTx(tx, {
          barbershopId: row.barbershop_id,
          userId,
          displayName: row.display_name,
          actorId: userId,
        });
      }
      await this.outbox.publish(tx, JOB_OFFER_EVENTS.ANSWERED, { offerId, accepted: accept });
      await this.audit.record(
        {
          actorId: userId,
          action: accept ? 'job_offer.accepted' : 'job_offer.rejected',
          entityType: 'job_offer',
          entityId: offerId,
          changes: {},
        },
        tx,
      );
    });
    return this.one(offerId);
  }

  /** Las pendientes que vencieron pasan a EXPIRED (se revisa al leer). */
  private async expireStale(): Promise<void> {
    await this.prisma.jobOffer.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date(this.clock.now()) } },
      data: { status: 'EXPIRED' },
    });
  }

  private async one(id: string): Promise<JobOfferDto> {
    const row = await this.prisma.jobOffer.findUnique({ where: { id }, include: offerInclude });
    if (!row) throw notFound();
    return (await this.toDtos([row]))[0]!;
  }

  private async toDtos(rows: OfferRow[]): Promise<JobOfferDto[]> {
    const media = await barbershopMedia(this.prisma, this.storage, [
      ...new Set(rows.map((r) => r.barbershopId)),
    ]);
    return rows.map((r) => ({
      id: r.id,
      barbershop: {
        id: r.barbershop.id,
        name: r.barbershop.name,
        address: r.barbershop.address,
        logoUrl: media.get(r.barbershopId)?.logoUrl ?? null,
        ratingAverage: r.barbershop.ratingCount > 0 ? Number(r.barbershop.ratingAvg) : null,
      },
      barberProfileId: r.barberProfile.id,
      barberName: r.barberProfile.displayName,
      title: r.title,
      message: r.message,
      employmentType: r.employmentType,
      payMin: r.payMin,
      payMax: r.payMax,
      payType: r.payType,
      payPeriod: r.payPeriod,
      schedule: r.schedule,
      status: r.status,
      expiresAt: r.expiresAt,
      respondedAt: r.respondedAt,
      responseNote: r.responseNote,
      createdAt: r.createdAt,
    }));
  }
}
