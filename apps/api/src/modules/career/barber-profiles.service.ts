import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbersService } from '../barbers/barbers.service';
import { PUBLIC_STATUSES } from '../barbershops/barbershop-access.service';
import { BookingsReadService } from '../bookings/bookings-read.service';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { variantUrl } from '../images/image-variants';
import type {
  BarberProfileDto,
  ProfileReviewPageDto,
  RankedBarberDto,
  RankingPageDto,
  RankingQueryDto,
  UpsertBarberProfileDto,
  WorkplaceDto,
} from './dto/career.dto';

/**
 * Ranking de barberos: promedio bayesiano, para que pocas valoraciones no pesen como muchas.
 * score = (PRIOR_WEIGHT · PRIOR_MEAN + promedio · n) / (PRIOR_WEIGHT + n). Entra al ranking con
 * `MIN_RATINGS` valoraciones visibles; a igual puntaje, más atenciones primero.
 */
export const RANKING = { PRIOR_MEAN: 4, PRIOR_WEIGHT: 5, MIN_RATINGS: 3 } as const;
// Constantes del ranking como SQL literal (con parámetros, `$1 * $2` no tiene tipo y falla).
const PRIOR_WEIGHT = Prisma.raw(String(RANKING.PRIOR_WEIGHT));
const PRIOR_MEAN = Prisma.raw(String(RANKING.PRIOR_MEAN));
const DEFAULT_LIMIT = 20;
const MAX_SPECIALTIES = 10;

const profileNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El perfil del barbero no existe.', HttpStatus.NOT_FOUND);

const noOwnProfile = (): AppException =>
  new AppException(
    ErrorCode.NOT_FOUND,
    'Aún no tienes perfil profesional. Créalo en PUT /me/barber-profile.',
    HttpStatus.NOT_FOUND,
  );

interface RankRow {
  id: string;
  display_name: string;
  headline: string | null;
  photo_variants: unknown;
  district: string | null;
  rating_avg: string;
  rating_count: number;
  attended: number;
  score: string;
  available_for_work: boolean;
}

/**
 * Carrera del barbero: perfil profesional (de la persona, no de la barbería), dónde trabaja,
 * dejar una barbería, valoraciones de toda su carrera y ranking público.
 */
@Injectable()
export class BarberProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly barbers: BarbersService,
    private readonly bookings: BookingsReadService,
    private readonly audit: AuditService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Mi perfil ─────────────

  async mine(userId: string): Promise<BarberProfileDto> {
    const profile = await this.prisma.barberProfile.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!profile) throw noOwnProfile();
    return this.view(profile.id, true);
  }

  /** Crea el perfil (la primera vez) o lo actualiza. Crearlo da el rol BARBER. */
  async upsertMine(
    userId: string,
    dto: UpsertBarberProfileDto,
    ip: string | null,
  ): Promise<BarberProfileDto> {
    const data = {
      displayName: dto.displayName,
      ...(dto.headline !== undefined ? { headline: dto.headline } : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
      ...(dto.yearsExperience !== undefined ? { yearsExperience: dto.yearsExperience } : {}),
      ...(dto.district !== undefined ? { district: dto.district } : {}),
      ...(dto.availableForWork !== undefined ? { availableForWork: dto.availableForWork } : {}),
    };
    const id = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.barberProfile.findUnique({
        where: { userId },
        select: { id: true, deletedAt: true },
      });
      const profile = await tx.barberProfile.upsert({
        where: { userId },
        update: { ...data, deletedAt: null },
        create: { userId, ...data },
        select: { id: true },
      });
      await this.barbers.syncBarberRole(userId, tx);
      await this.audit.record(
        {
          actorId: userId,
          action:
            existing && !existing.deletedAt ? 'barber_profile.updated' : 'barber_profile.created',
          entityType: 'barber_profile',
          entityId: profile.id,
          // Datos personales: solo los nombres de los campos.
          changes: { fields: Object.keys(dto) },
          ip,
        },
        tx,
      );
      return profile.id;
    });
    return this.view(id, true);
  }

  async setSpecialties(userId: string, styleIds: string[]): Promise<BarberProfileDto> {
    const profile = await this.prisma.barberProfile.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!profile) throw noOwnProfile();
    const unique = [...new Set(styleIds)].slice(0, MAX_SPECIALTIES);
    const active = await this.prisma.serviceStyle.count({
      where: { id: { in: unique }, isActive: true },
    });
    if (active !== unique.length) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'styleIds', constraints: ['activeStyle'] }],
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.barberProfileSpecialty.deleteMany({ where: { profileId: profile.id } });
      await tx.barberProfileSpecialty.createMany({
        data: unique.map((styleId) => ({ profileId: profile.id, styleId })),
      });
    });
    return this.view(profile.id, true);
  }

  /**
   * El barbero deja una barbería: el vínculo termina (no se borra), su progreso queda en su
   * perfil y la barbería deja de mostrar sus cortes. Con reservas futuras activas, 409.
   */
  async leave(userId: string, barberId: string, ip: string | null): Promise<BarberProfileDto> {
    const link = await this.prisma.barber.findFirst({
      where: { id: barberId, userId, deletedAt: null, endedAt: null },
      select: {
        id: true,
        barbershopId: true,
        barberProfileId: true,
        barbershop: { select: { type: true } },
      },
    });
    if (!link || !link.barberProfileId) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'No trabajas en esa barbería.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (link.barbershop.type === 'INDEPENDENT') {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Es tu barbería independiente: para dejarla, elimínala o pásala a otra persona.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM barbers WHERE id = ${barberId}::uuid FOR UPDATE`;
      if (await this.bookings.hasFutureActive({ barberId }, tx)) {
        throw new AppException(
          ErrorCode.HAS_FUTURE_BOOKINGS,
          'Tienes reservas futuras en esta barbería. Atiéndelas o pide que las reasignen antes de irte.',
          HttpStatus.CONFLICT,
        );
      }
      await tx.barber.update({
        where: { id: barberId },
        data: { isActive: false, endedAt: new Date(this.clock.now()) },
      });
      await this.barbers.syncBarberRole(userId, tx);
      await this.audit.record(
        {
          actorId: userId,
          action: 'barber.left',
          entityType: 'barber',
          entityId: barberId,
          changes: { barbershopId: link.barbershopId },
          ip,
        },
        tx,
      );
    });
    return this.view(link.barberProfileId, true);
  }

  // ───────────── Público ─────────────

  async publicProfile(id: string): Promise<BarberProfileDto> {
    const found = await this.prisma.barberProfile.count({ where: { id, deletedAt: null } });
    if (!found) throw profileNotFound();
    return this.view(id, false);
  }

  /** Valoraciones visibles de toda su carrera, más recientes primero (sin datos del cliente). */
  async reviews(
    profileId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<ProfileReviewPageDto> {
    const found = await this.prisma.barberProfile.count({
      where: { id: profileId, deletedAt: null },
    });
    if (!found) throw profileNotFound();
    const limit = query.limit ?? DEFAULT_LIMIT;
    const rows = await this.prisma.review.findMany({
      where: {
        barberProfileId: profileId,
        deletedAt: null,
        status: 'VISIBLE',
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        rating: true,
        comment: true,
        createdAt: true,
        client: { select: { username: true, anonymizedAt: true } },
        barbershop: { select: { name: true } },
        booking: { select: { serviceNameSnapshot: true } },
      },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        clientName: r.client.anonymizedAt ? 'Cuenta eliminada' : r.client.username,
        barbershopName: r.barbershop.name,
        serviceName: r.booking.serviceNameSnapshot,
        createdAt: r.createdAt,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  /**
   * Ranking y búsqueda de barberos. `rank` es el puesto dentro de esta lista (con sus filtros);
   * quien aún no tiene `MIN_RATINGS` valoraciones va después, sin puesto.
   */
  async ranking(query: RankingQueryDto): Promise<RankingPageDto> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    const filters: Prisma.Sql[] = [
      Prisma.sql`p.deleted_at IS NULL`,
      Prisma.sql`u.anonymized_at IS NULL`,
    ];
    if (query.availableForWork) filters.push(Prisma.sql`p.available_for_work = true`);
    if (query.district)
      filters.push(Prisma.sql`p.district ILIKE ${`%${escapeLike(query.district)}%`}`);
    if (query.q) filters.push(Prisma.sql`p.display_name ILIKE ${`%${escapeLike(query.q)}%`}`);
    if (query.style) {
      filters.push(Prisma.sql`EXISTS (
        SELECT 1 FROM barber_profile_specialties ps JOIN service_styles st ON st.id = ps.style_id
         WHERE ps.profile_id = p.id AND st.key = ${query.style} AND st.is_active)`);
    }
    const order =
      query.sort === 'newest'
        ? Prisma.sql`p.created_at DESC, p.id`
        : Prisma.sql`(p.rating_count >= ${RANKING.MIN_RATINGS}) DESC, score DESC, attended DESC, p.id`;
    const rows = await this.prisma.$queryRaw<RankRow[]>`
      SELECT p.id::text AS id, p.display_name, p.headline, p.photo_variants, p.district,
             p.rating_avg::text AS rating_avg, p.rating_count, p.available_for_work,
             (SELECT COUNT(*)::int FROM bookings b
               WHERE b.barber_profile_id = p.id AND b.status = 'ATTENDED') AS attended,
             ROUND(((${PRIOR_WEIGHT} * ${PRIOR_MEAN} + p.rating_avg * p.rating_count)
                    / (${PRIOR_WEIGHT} + p.rating_count))::numeric, 3)::text AS score
        FROM barber_profiles p JOIN users u ON u.id = p.user_id
       WHERE ${Prisma.join(filters, ' AND ')}
       ORDER BY ${order}
       LIMIT ${limit + 1} OFFSET ${offset}`;
    const page = rows.slice(0, limit);
    const [specialties, shops] = await Promise.all([
      this.specialtiesOf(page.map((r) => r.id)),
      this.currentShopsOf(page.map((r) => r.id)),
    ]);
    return {
      items: page.map((r, i): RankedBarberDto => ({
        id: r.id,
        rank:
          query.sort !== 'newest' && r.rating_count >= RANKING.MIN_RATINGS ? offset + i + 1 : null,
        displayName: r.display_name,
        headline: r.headline,
        photoUrl: variantUrl(this.storage, r.photo_variants, 'square'),
        district: r.district,
        ratingAverage: r.rating_count > 0 ? Number(r.rating_avg) : null,
        ratingCount: r.rating_count,
        attendedCount: r.attended,
        score: Number(r.score),
        availableForWork: r.available_for_work,
        specialties: specialties.get(r.id) ?? [],
        currentBarbershops: (shops.get(r.id) ?? []).map((w) => w.barbershopName),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }

  // ───────────── Común ─────────────

  private async view(id: string, includePast: boolean): Promise<BarberProfileDto> {
    const p = await this.prisma.barberProfile.findUniqueOrThrow({ where: { id } });
    const [attended, specialties, workplaces, rank] = await Promise.all([
      this.prisma.booking.count({ where: { barberProfileId: id, status: 'ATTENDED' } }),
      this.specialtiesOf([id]),
      this.workplacesOf(id, includePast),
      this.globalRank(id, Number(p.ratingAvg), p.ratingCount),
    ]);
    return {
      id: p.id,
      displayName: p.displayName,
      headline: p.headline,
      bio: p.bio,
      photoUrl: variantUrl(this.storage, p.photoVariants, 'square'),
      yearsExperience: p.yearsExperience,
      district: p.district,
      availableForWork: p.availableForWork,
      ratingAverage: p.ratingCount > 0 ? Number(p.ratingAvg) : null,
      ratingCount: p.ratingCount,
      attendedCount: attended,
      rank,
      specialties: specialties.get(id) ?? [],
      workplaces,
      createdAt: p.createdAt,
    };
  }

  /** Puesto en el ranking general (sin filtros); null si aún no tiene las valoraciones mínimas. */
  private async globalRank(id: string, average: number, count: number): Promise<number | null> {
    if (count < RANKING.MIN_RATINGS) return null;
    const score =
      (RANKING.PRIOR_WEIGHT * RANKING.PRIOR_MEAN + average * count) /
      (RANKING.PRIOR_WEIGHT + count);
    const [row] = await this.prisma.$queryRaw<{ ahead: number }[]>`
      SELECT COUNT(*)::int AS ahead FROM barber_profiles p JOIN users u ON u.id = p.user_id
       WHERE p.deleted_at IS NULL AND u.anonymized_at IS NULL AND p.id <> ${id}::uuid
         AND p.rating_count >= ${RANKING.MIN_RATINGS}
         AND (${PRIOR_WEIGHT} * ${PRIOR_MEAN} + p.rating_avg * p.rating_count)
             / (${PRIOR_WEIGHT} + p.rating_count) > ${score}::numeric`;
    return (row?.ahead ?? 0) + 1;
  }

  private async specialtiesOf(
    profileIds: string[],
  ): Promise<Map<string, { id: string; key: string; name: string }[]>> {
    const rows = await this.prisma.barberProfileSpecialty.findMany({
      where: { profileId: { in: profileIds }, style: { isActive: true } },
      select: {
        profileId: true,
        style: { select: { id: true, key: true, name: true, sortOrder: true } },
      },
      orderBy: { style: { sortOrder: 'asc' } },
    });
    const result = new Map<string, { id: string; key: string; name: string }[]>();
    for (const r of rows) {
      const { id, key, name } = r.style;
      result.set(r.profileId, [...(result.get(r.profileId) ?? []), { id, key, name }]);
    }
    return result;
  }

  private async currentShopsOf(profileIds: string[]): Promise<Map<string, WorkplaceDto[]>> {
    const rows = await this.prisma.barber.findMany({
      where: {
        barberProfileId: { in: profileIds },
        deletedAt: null,
        endedAt: null,
        isActive: true,
        barbershop: { deletedAt: null, status: { in: PUBLIC_STATUSES } },
      },
      select: {
        id: true,
        barberProfileId: true,
        createdAt: true,
        barbershop: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const result = new Map<string, WorkplaceDto[]>();
    for (const r of rows) {
      result.set(r.barberProfileId!, [
        ...(result.get(r.barberProfileId!) ?? []),
        toWorkplace(r, null),
      ]);
    }
    return result;
  }

  private async workplacesOf(profileId: string, includePast: boolean): Promise<WorkplaceDto[]> {
    if (!includePast) return (await this.currentShopsOf([profileId])).get(profileId) ?? [];
    const rows = await this.prisma.barber.findMany({
      where: { barberProfileId: profileId, barbershop: { deletedAt: null } },
      select: {
        id: true,
        barberProfileId: true,
        createdAt: true,
        endedAt: true,
        deletedAt: true,
        isActive: true,
        barbershop: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) =>
      toWorkplace(r, r.endedAt ?? r.deletedAt ?? null, r.isActive && !r.endedAt && !r.deletedAt),
    );
  }
}

function toWorkplace(
  r: { id: string; createdAt: Date; barbershop: { id: string; name: string; type: string } },
  until: Date | null,
  current = true,
): WorkplaceDto {
  return {
    barberId: r.id,
    barbershopId: r.barbershop.id,
    barbershopName: r.barbershop.name,
    barbershopType: r.barbershop.type,
    current,
    since: r.createdAt,
    until,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
