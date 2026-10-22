import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService, PUBLIC_STATUSES } from '../barbershops/barbershop-access.service';
import { barbershopMedia } from '../images/barbershop-media';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { variantUrl } from '../images/image-variants';
import { InvitationsService } from '../invitations/invitations.service';
import { MessagingService } from '../messaging/messaging.service';
import { UsersService } from '../users/users.service';
import type {
  CreateJobPostingDto,
  JobApplicationDto,
  JobPostingDto,
  JobPostingPageDto,
  JobsQueryDto,
  UpdateJobPostingDto,
  JobPostingTermsDto,
} from './dto/jobs.dto';
import { locationOf, LocationsService } from '../locations/locations';

const DEFAULT_LIMIT = 20;
const MAX_OPEN_POSTINGS = 10;
const MAX_CLOSES_DAYS = 90;
const DAY_MS = 86_400_000;
/** Postulaciones que siguen en juego (cuentan para la barbería). */
const LIVE_APPLICATIONS = ['APPLIED', 'SHORTLISTED'] as const;

const postingInclude = {
  barbershop: {
    select: {
      id: true,
      name: true,
      address: true,
      ratingAvg: true,
      ratingCount: true,
      districtId: true,
    },
  },
} satisfies Prisma.JobPostingInclude;
type PostingRow = Prisma.JobPostingGetPayload<{ include: typeof postingInclude }>;

const applicationInclude = {
  posting: {
    select: { id: true, title: true, barbershopId: true, barbershop: { select: { name: true } } },
  },
  barberProfile: {
    select: {
      id: true,
      userId: true,
      displayName: true,
      photoVariants: true,
      ratingAvg: true,
      ratingCount: true,
      yearsExperience: true,
    },
  },
} satisfies Prisma.JobApplicationInclude;
type ApplicationRow = Prisma.JobApplicationGetPayload<{ include: typeof applicationInclude }>;

const postingNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La oferta no existe.', HttpStatus.NOT_FOUND);
const applicationNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La postulación no existe.', HttpStatus.NOT_FOUND);
const invalid = (field: string, constraint: string): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );

/**
 * Bolsa de trabajo (Carrera del barbero): ofertas de las barberías, postulaciones de los
 * barberos con perfil profesional, decisión (preseleccionar, rechazar, contratar) e invitación
 * directa desde el perfil del barbero. Todo deja un mensaje en el correo interno.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly locations: LocationsService,
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly barbers: BarbersService,
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
    private readonly messaging: MessagingService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Público y barberos ─────────────

  async list(query: JobsQueryDto, viewerId: string | null): Promise<JobPostingPageDto> {
    const now = new Date(this.clock.now());
    const limit = query.limit ?? DEFAULT_LIMIT;
    // Cercanía: barberías dentro del radio, con su distancia en km.
    const near =
      query.lat !== undefined && query.lng !== undefined
        ? await this.shopsNear(query.lat, query.lng, query.radiusKm ?? 20)
        : null;
    const byDistance = query.sort === 'distance' && near !== null;
    let styleId: string | null = null;
    if (query.style) {
      const style = await this.prisma.serviceStyle.findFirst({
        where: { key: query.style, isActive: true },
        select: { id: true },
      });
      if (!style) throw invalid('style', 'activeStyle');
      styleId = style.id;
    }
    const rows = await this.prisma.jobPosting.findMany({
      where: {
        status: 'OPEN',
        OR: [{ closesAt: null }, { closesAt: { gt: now } }],
        barbershop: {
          deletedAt: null,
          status: { in: PUBLIC_STATUSES },
          ...(query.area ? { address: { contains: query.area, mode: 'insensitive' } } : {}),
        },
        ...(query.employmentType ? { employmentType: query.employmentType } : {}),
        ...(styleId ? { styleIds: { has: styleId } } : {}),
        ...(query.ubigeo ? { districtId: this.locations.resolve(query.ubigeo).id } : {}),
        ...(query.province
          ? { districtId: { in: this.locations.districtIdsOfProvince(query.province) } }
          : {}),
        ...(near ? { barbershopId: { in: [...near.keys()] } } : {}),
        ...(query.cursor && !byDistance ? { id: { lt: query.cursor } } : {}),
      },
      include: postingInclude,
      orderBy: { id: 'desc' },
      take: byDistance ? 50 : limit + 1,
    });
    if (byDistance) {
      rows.sort((a, b) => (near.get(a.barbershopId) ?? 0) - (near.get(b.barbershopId) ?? 0));
      return { items: await this.toPostings(rows, viewerId, false, near), nextCursor: null };
    }
    const page = rows.slice(0, limit);
    return {
      items: await this.toPostings(page, viewerId, false, near),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  async get(id: string, viewerId: string | null): Promise<JobPostingDto> {
    const row = await this.prisma.jobPosting.findFirst({
      where: { id, barbershop: { deletedAt: null, status: { in: PUBLIC_STATUSES } } },
      include: postingInclude,
    });
    if (!row) throw postingNotFound();
    return (await this.toPostings([row], viewerId, false))[0]!;
  }

  /** El barbero postula (necesita perfil profesional). Llega a la barbería por su bandeja. */
  async apply(
    userId: string,
    postingId: string,
    message: string | undefined,
  ): Promise<JobApplicationDto> {
    const profile = await this.prisma.barberProfile.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true, displayName: true },
    });
    if (!profile) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'Para postular, crea primero tu perfil profesional.',
        HttpStatus.FORBIDDEN,
      );
    }
    const posting = await this.prisma.jobPosting.findFirst({
      where: { id: postingId, barbershop: { deletedAt: null, status: { in: PUBLIC_STATUSES } } },
      select: { id: true, title: true, status: true, closesAt: true, barbershopId: true },
    });
    if (!posting) throw postingNotFound();
    if (!this.isOpen(posting)) {
      throw new AppException(
        ErrorCode.JOB_POSTING_CLOSED,
        'La oferta ya está cerrada.',
        HttpStatus.CONFLICT,
      );
    }
    if (await this.access.isMember(posting.barbershopId, userId)) {
      throw new AppException(
        ErrorCode.FORBIDDEN,
        'No puedes postular a tu propia barbería.',
        HttpStatus.FORBIDDEN,
      );
    }
    const working = await this.prisma.barber.count({
      where: { barbershopId: posting.barbershopId, userId, deletedAt: null, endedAt: null },
    });
    if (working) {
      throw new AppException(
        ErrorCode.ALREADY_APPLIED,
        'Ya trabajas en esta barbería.',
        HttpStatus.CONFLICT,
      );
    }
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const created = await tx.jobApplication.upsert({
          where: { postingId_barberProfileId: { postingId, barberProfileId: profile.id } },
          // Quien se había retirado puede volver a postular.
          update: { status: 'APPLIED', message: message ?? null, decidedAt: null },
          create: { postingId, barberProfileId: profile.id, message: message ?? null },
          select: { id: true, status: true, createdAt: true, updatedAt: true },
        });
        await this.messaging.postSystem(tx, {
          barbershopId: posting.barbershopId,
          userId,
          kind: 'PROFESSIONAL',
          body:
            `${profile.displayName} postuló a «${posting.title}».` +
            (message ? `\n\n${message}` : ''),
        });
        await this.outbox.publish(tx, 'job.application_created', { applicationId: created.id });
        return created.id;
      });
    } catch (error) {
      throw this.mapDuplicate(error);
    }
    return this.application(id);
  }

  async withdraw(userId: string, applicationId: string): Promise<JobApplicationDto> {
    const row = await this.prisma.jobApplication.findFirst({
      where: { id: applicationId, barberProfile: { userId } },
      select: { status: true },
    });
    if (!row) throw applicationNotFound();
    if (!(LIVE_APPLICATIONS as readonly string[]).includes(row.status)) {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'Esta postulación ya no se puede retirar.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.jobApplication.update({
      where: { id: applicationId },
      data: { status: 'WITHDRAWN', decidedAt: new Date(this.clock.now()) },
    });
    return this.application(applicationId);
  }

  async mine(userId: string): Promise<JobApplicationDto[]> {
    const rows = await this.prisma.jobApplication.findMany({
      where: { barberProfile: { userId } },
      include: applicationInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => this.toApplication(r));
  }

  // ───────────── Barbería (OWNER o MANAGER) ─────────────

  async listForShop(actorId: string, barbershopId: string): Promise<JobPostingDto[]> {
    await this.access.requireMember(actorId, barbershopId);
    const rows = await this.prisma.jobPosting.findMany({
      where: { barbershopId },
      include: postingInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.toPostings(rows, null, true);
  }

  async create(
    actorId: string,
    barbershopId: string,
    dto: CreateJobPostingDto,
  ): Promise<JobPostingDto> {
    await this.access.requireMember(actorId, barbershopId);
    await this.assertStyles(dto.styleIds ?? []);
    this.assertClosesAt(dto.closesAt ?? null);
    this.assertPay(dto.payMin ?? null, dto.payMax ?? null);
    const open = await this.prisma.jobPosting.count({ where: { barbershopId, status: 'OPEN' } });
    if (open >= MAX_OPEN_POSTINGS) {
      throw new AppException(
        ErrorCode.CONFLICT,
        `Una barbería tiene como máximo ${MAX_OPEN_POSTINGS} ofertas abiertas.`,
        HttpStatus.CONFLICT,
      );
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.jobPosting.create({
        data: {
          barbershopId,
          title: dto.title,
          description: dto.description,
          employmentType: dto.employmentType,
          compensationText: dto.compensationText ?? null,
          styleIds: dto.styleIds ?? [],
          closesAt: dto.closesAt ?? null,
          createdById: actorId,
          ...this.termsData(dto),
          districtId: dto.ubigeo
            ? this.locations.resolve(dto.ubigeo).id
            : ((
                await tx.barbershop.findUnique({
                  where: { id: barbershopId },
                  select: { districtId: true },
                })
              )?.districtId ?? null),
        },
        include: postingInclude,
      });
      await this.audit.record(
        { actorId, action: 'job_posting.created', entityType: 'job_posting', entityId: created.id },
        tx,
      );
      return created;
    });
    return (await this.toPostings([row], null, true))[0]!;
  }

  async update(
    actorId: string,
    barbershopId: string,
    postingId: string,
    dto: UpdateJobPostingDto,
  ): Promise<JobPostingDto> {
    await this.access.requireMember(actorId, barbershopId);
    const current = await this.prisma.jobPosting.findFirst({
      where: { id: postingId, barbershopId },
    });
    if (!current) throw postingNotFound();
    if (dto.styleIds) await this.assertStyles(dto.styleIds);
    if (dto.closesAt !== undefined) this.assertClosesAt(dto.closesAt);
    this.assertPay(dto.payMin ?? current.payMin, dto.payMax ?? current.payMax);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.jobPosting.update({
        where: { id: postingId },
        data: (() => {
          const { ubigeo, ...rest } = dto;
          return {
            ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
            ...(ubigeo === undefined
              ? {}
              : { districtId: ubigeo ? this.locations.resolve(ubigeo).id : null }),
          };
        })(),
        include: postingInclude,
      });
      await this.audit.record(
        {
          actorId,
          action: 'job_posting.updated',
          entityType: 'job_posting',
          entityId: postingId,
          changes: { fields: Object.keys(dto), ...(dto.status ? { status: dto.status } : {}) },
        },
        tx,
      );
      return updated;
    });
    return (await this.toPostings([row], null, true))[0]!;
  }

  async applications(
    actorId: string,
    barbershopId: string,
    postingId: string,
  ): Promise<JobApplicationDto[]> {
    await this.access.requireMember(actorId, barbershopId);
    const found = await this.prisma.jobPosting.count({ where: { id: postingId, barbershopId } });
    if (!found) throw postingNotFound();
    const rows = await this.prisma.jobApplication.findMany({
      where: { postingId, status: { not: 'WITHDRAWN' } },
      include: applicationInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toApplication(r));
  }

  /**
   * Preseleccionar, rechazar o contratar. Contratar crea el vínculo del barbero en la barbería
   * (enlazado a su perfil) en la misma transacción; el barbero recibe un mensaje y un aviso.
   */
  async decide(
    actorId: string,
    barbershopId: string,
    applicationId: string,
    status: 'SHORTLISTED' | 'REJECTED' | 'HIRED',
  ): Promise<JobApplicationDto> {
    await this.access.requireMember(actorId, barbershopId);
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ status: string; posting_id: string }[]>`
        SELECT a.status::text AS status, a.posting_id::text AS posting_id
          FROM job_applications a JOIN job_postings p ON p.id = a.posting_id
         WHERE a.id = ${applicationId}::uuid AND p.barbershop_id = ${barbershopId}::uuid
           FOR UPDATE OF a`;
      if (!row) throw applicationNotFound();
      if (!(LIVE_APPLICATIONS as readonly string[]).includes(row.status)) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'Esta postulación ya fue decidida o retirada.',
          HttpStatus.CONFLICT,
          [{ from: row.status, to: status }],
        );
      }
      const application = await tx.jobApplication.update({
        where: { id: applicationId },
        data: { status, decidedAt: new Date(this.clock.now()) },
        include: applicationInclude,
      });
      if (status === 'HIRED') {
        await this.barbers.hireInTx(tx, {
          barbershopId,
          userId: application.barberProfile.userId,
          displayName: application.barberProfile.displayName,
          actorId,
        });
      }
      const texts = {
        SHORTLISTED: `Te preseleccionamos para «${application.posting.title}».`,
        REJECTED: `Gracias por postular a «${application.posting.title}». Esta vez no continuaremos.`,
        HIRED: `¡Bienvenido al equipo! Te contratamos para «${application.posting.title}».`,
      };
      await this.messaging.postSystem(tx, {
        barbershopId,
        userId: application.barberProfile.userId,
        kind: 'PROFESSIONAL',
        body: texts[status],
      });
      await this.outbox.publish(tx, 'job.application_updated', { applicationId, status });
      await this.audit.record(
        {
          actorId,
          action: 'job_application.decided',
          entityType: 'job_application',
          entityId: applicationId,
          changes: { status },
        },
        tx,
      );
    });
    return this.application(applicationId);
  }

  /**
   * Invitar a un barbero desde su perfil: crea su vínculo (sin cuenta aún) en la barbería y le envía
   * la invitación de siempre (código por correo) más un mensaje a su bandeja. Al aceptarla, el
   * vínculo queda enlazado a su perfil.
   */
  async inviteProfile(
    actor: AuthUser,
    barbershopId: string,
    profileId: string,
    message: string | undefined,
  ): Promise<{ barberId: string }> {
    await this.access.requireMember(actor.id, barbershopId);
    const profile = await this.prisma.barberProfile.findFirst({
      where: { id: profileId, deletedAt: null },
      select: { userId: true, displayName: true },
    });
    if (!profile) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);
    }
    const already = await this.prisma.barber.count({
      where: { barbershopId, userId: profile.userId, deletedAt: null },
    });
    if (already) {
      throw new AppException(
        ErrorCode.BARBER_ALREADY_ACTIVE_ELSEWHERE,
        'Este barbero ya trabaja en tu barbería.',
        HttpStatus.CONFLICT,
      );
    }
    const email = await this.users.contactEmail(profile.userId);
    if (!email) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);
    }
    const barber = await this.barbers.create(
      actor.id,
      barbershopId,
      { displayName: profile.displayName },
      null,
    );
    await this.invitations.inviteBarber(actor, barbershopId, barber.id, email);
    const shop = await this.prisma.barbershop.findUniqueOrThrow({
      where: { id: barbershopId },
      select: { name: true },
    });
    await this.prisma.$transaction((tx) =>
      this.messaging.postSystem(tx, {
        barbershopId,
        userId: profile.userId,
        kind: 'PROFESSIONAL',
        body:
          `${shop.name} te invitó a su equipo. Revisa tu correo para el código o ve a «Invitaciones».` +
          (message ? `\n\n${message}` : ''),
      }),
    );
    return { barberId: barber.id };
  }

  // ───────────── Internos ─────────────

  private isOpen(p: { status: string; closesAt: Date | null }): boolean {
    return p.status === 'OPEN' && (!p.closesAt || p.closesAt.getTime() > this.clock.now());
  }

  private assertClosesAt(closesAt: Date | null): void {
    if (!closesAt) return;
    const now = this.clock.now();
    if (closesAt.getTime() <= now) throw invalid('closesAt', 'future');
    if (closesAt.getTime() - now > MAX_CLOSES_DAYS * DAY_MS)
      throw invalid('closesAt', 'maxDuration');
  }

  private async assertStyles(styleIds: string[]): Promise<void> {
    if (styleIds.length === 0) return;
    const active = await this.prisma.serviceStyle.count({
      where: { id: { in: styleIds }, isActive: true },
    });
    if (active !== styleIds.length) throw invalid('styleIds', 'activeStyle');
  }

  private mapDuplicate(error: unknown): unknown {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return new AppException(
        ErrorCode.ALREADY_APPLIED,
        'Ya postulaste a esta oferta.',
        HttpStatus.CONFLICT,
      );
    }
    return error;
  }

  private async application(id: string): Promise<JobApplicationDto> {
    const row = await this.prisma.jobApplication.findUniqueOrThrow({
      where: { id },
      include: applicationInclude,
    });
    return this.toApplication(row);
  }

  private toApplication(r: ApplicationRow): JobApplicationDto {
    return {
      id: r.id,
      postingId: r.posting.id,
      postingTitle: r.posting.title,
      barbershopName: r.posting.barbershop.name,
      applicant: {
        barberProfileId: r.barberProfile.id,
        displayName: r.barberProfile.displayName,
        photoUrl: variantUrl(this.storage, r.barberProfile.photoVariants, 'square'),
        ratingAverage: r.barberProfile.ratingCount > 0 ? Number(r.barberProfile.ratingAvg) : null,
        ratingCount: r.barberProfile.ratingCount,
        yearsExperience: r.barberProfile.yearsExperience,
      },
      message: r.message,
      status: r.status,
      decidedAt: r.decidedAt,
      createdAt: r.createdAt,
    };
  }

  private termsData(
    dto: JobPostingTermsDto,
  ): Pick<
    Prisma.JobPostingUncheckedCreateInput,
    | 'payMin'
    | 'payMax'
    | 'payType'
    | 'payPeriod'
    | 'negotiable'
    | 'requirements'
    | 'selectionProcess'
    | 'schedule'
  > {
    return {
      payMin: dto.payMin ?? null,
      payMax: dto.payMax ?? null,
      payType: dto.payType ?? null,
      payPeriod: dto.payPeriod ?? null,
      negotiable: dto.negotiable ?? false,
      requirements: dto.requirements ?? [],
      selectionProcess: dto.selectionProcess ?? null,
      schedule: dto.schedule ?? null,
    };
  }

  assertPay(min: number | null | undefined, max: number | null | undefined): void {
    if (min != null && max != null && min > max) throw invalid('payMax', 'notBelowPayMin');
  }

  /** Barberías visibles dentro del radio: id → km. */
  private async shopsNear(
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<Map<string, number>> {
    const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography`;
    const rows = await this.prisma.$queryRaw<{ id: string; km: number }[]>`
      SELECT b.id::text AS id, ROUND((ST_Distance(b.location, ${point}) / 1000)::numeric, 2)::float8 AS km
        FROM barbershops b
       WHERE b.deleted_at IS NULL AND ST_DWithin(b.location, ${point}, ${radiusKm * 1000}::float8)`;
    return new Map(rows.map((r) => [r.id, r.km]));
  }

  private async toPostings(
    rows: PostingRow[],
    viewerId: string | null,
    forShop: boolean,
    near: Map<string, number> | null = null,
  ): Promise<JobPostingDto[]> {
    const ids = rows.map((r) => r.id);
    const styleIds = [...new Set(rows.flatMap((r) => r.styleIds))];
    const [media, styles, counts, mine] = await Promise.all([
      barbershopMedia(this.prisma, this.storage, [...new Set(rows.map((r) => r.barbershopId))]),
      this.prisma.serviceStyle.findMany({
        where: { id: { in: styleIds } },
        select: { id: true, key: true, name: true },
      }),
      forShop
        ? this.prisma.jobApplication.groupBy({
            by: ['postingId'],
            where: { postingId: { in: ids }, status: { in: [...LIVE_APPLICATIONS] } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      viewerId
        ? this.prisma.jobApplication.findMany({
            where: { postingId: { in: ids }, barberProfile: { userId: viewerId } },
            select: { postingId: true, status: true },
          })
        : Promise.resolve([]),
    ]);
    const styleById = new Map(styles.map((s) => [s.id, s]));
    const countBy = new Map(counts.map((c) => [c.postingId, c._count._all]));
    const mineBy = new Map(mine.map((m) => [m.postingId, m.status]));
    return rows.map((r) => ({
      id: r.id,
      barbershop: {
        id: r.barbershop.id,
        name: r.barbershop.name,
        address: r.barbershop.address,
        logoUrl: media.get(r.barbershopId)?.logoUrl ?? null,
        ratingAverage: r.barbershop.ratingCount > 0 ? Number(r.barbershop.ratingAvg) : null,
      },
      title: r.title,
      description: r.description,
      employmentType: r.employmentType,
      compensationText: r.compensationText,
      styles: r.styleIds.flatMap((id) => (styleById.get(id) ? [styleById.get(id)!] : [])),
      payMin: r.payMin,
      payMax: r.payMax,
      payType: r.payType,
      payPeriod: r.payPeriod,
      negotiable: r.negotiable,
      location: locationOf(r.districtId ?? r.barbershop.districtId),
      requirements: r.requirements,
      selectionProcess: r.selectionProcess,
      schedule: r.schedule,
      distanceKm: near?.get(r.barbershopId) ?? null,
      status: this.isOpen(r) ? 'OPEN' : 'CLOSED',
      closesAt: r.closesAt,
      applicationsCount: countBy.get(r.id) ?? 0,
      myApplicationStatus: mineBy.get(r.id) ?? null,
      createdAt: r.createdAt,
    }));
  }
}
