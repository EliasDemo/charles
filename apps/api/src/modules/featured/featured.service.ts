import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import type { CreateFeaturedDto, FeaturedListingDto } from './dto/featured.dto';

const MAX_DAYS = 365;
const DAY_MS = 86_400_000;

const invalid = (field: string, constraint: string): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );

/**
 * Destacados en la búsqueda (Fase 13). Los asigna ADMIN, sin cobro: la venta de destacados llega
 * con los planes (Fase 15). La búsqueda los usa a través de `FeaturedRankingStrategy`.
 */
@Injectable()
export class FeaturedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** De entre `ids`, las que tienen un destacado vigente, por prioridad (mayor primero). */
  async activeAmong(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const now = new Date(this.clock.now());
    const rows = await this.prisma.featuredListing.findMany({
      where: {
        barbershopId: { in: ids },
        cancelledAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      orderBy: [{ priority: 'desc' }, { startsAt: 'asc' }, { id: 'asc' }],
      select: { barbershopId: true },
    });
    return [...new Set(rows.map((r) => r.barbershopId))];
  }

  async list(includePast: boolean): Promise<FeaturedListingDto[]> {
    const now = new Date(this.clock.now());
    const rows = await this.prisma.featuredListing.findMany({
      where: includePast ? {} : { cancelledAt: null, endsAt: { gt: now } },
      orderBy: [{ startsAt: 'desc' }],
      take: 200,
    });
    const names = await this.access.namesIncludingDeleted([
      ...new Set(rows.map((r) => r.barbershopId)),
    ]);
    return rows.map((r) => this.toDto(r, names.get(r.barbershopId) ?? null));
  }

  async create(actorId: string, dto: CreateFeaturedDto): Promise<FeaturedListingDto> {
    await this.access.requirePublic(dto.barbershopId);
    const startsAt = dto.startsAt ?? new Date(this.clock.now());
    if (dto.endsAt <= startsAt) throw invalid('endsAt', 'afterStartsAt');
    if (dto.endsAt.getTime() - startsAt.getTime() > MAX_DAYS * DAY_MS) {
      throw invalid('endsAt', 'maxDuration');
    }
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.featuredListing.create({
        data: {
          barbershopId: dto.barbershopId,
          startsAt,
          endsAt: dto.endsAt,
          priority: dto.priority ?? 0,
          note: dto.note ?? null,
          createdById: actorId,
        },
      });
      await this.audit.record(
        {
          actorId,
          action: 'featured.created',
          entityType: 'featured_listing',
          entityId: created.id,
          changes: { barbershopId: dto.barbershopId, startsAt, endsAt: dto.endsAt },
        },
        tx,
      );
      return created;
    });
    const names = await this.access.namesIncludingDeleted([row.barbershopId]);
    return this.toDto(row, names.get(row.barbershopId) ?? null);
  }

  /** Retira un destacado antes de tiempo (idempotente). */
  async cancel(actorId: string, id: string): Promise<FeaturedListingDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const found = await tx.featuredListing.findUnique({ where: { id } });
      if (!found) {
        throw new AppException(
          ErrorCode.NOT_FOUND,
          'El destacado no existe.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (found.cancelledAt) return found;
      const updated = await tx.featuredListing.update({
        where: { id },
        data: { cancelledAt: new Date(this.clock.now()) },
      });
      await this.audit.record(
        { actorId, action: 'featured.cancelled', entityType: 'featured_listing', entityId: id },
        tx,
      );
      return updated;
    });
    const names = await this.access.namesIncludingDeleted([row.barbershopId]);
    return this.toDto(row, names.get(row.barbershopId) ?? null);
  }

  private toDto(
    r: {
      id: string;
      barbershopId: string;
      startsAt: Date;
      endsAt: Date;
      priority: number;
      note: string | null;
      cancelledAt: Date | null;
      createdAt: Date;
    },
    barbershopName: string | null,
  ): FeaturedListingDto {
    const now = this.clock.now();
    return {
      id: r.id,
      barbershopId: r.barbershopId,
      barbershopName,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      priority: r.priority,
      note: r.note,
      status: r.cancelledAt
        ? 'CANCELLED'
        : r.startsAt.getTime() > now
          ? 'SCHEDULED'
          : r.endsAt.getTime() <= now
            ? 'ENDED'
            : 'ACTIVE',
      createdAt: r.createdAt,
    };
  }
}
