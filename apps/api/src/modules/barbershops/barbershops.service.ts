import { HttpStatus, Injectable } from '@nestjs/common';
import { auditChanges } from '../../common/audit/audit-diff';
import { AuditService } from '../../common/audit/audit.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  type Page,
  type PaginationQueryDto,
  pageArgs,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Barbershop, Prisma } from '../../generated/prisma/client';
import type { BarbershopMemberRole } from '../../generated/prisma/enums';
import { BookingsReadService } from '../bookings/bookings-read.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { BarbershopAccessService, publicBarbershopWhere } from './barbershop-access.service';
import {
  type BarbershopManageDto,
  type BarbershopPublicDto,
  type CreateBarbershopDto,
  type CreatedBarbershopDto,
  DEFAULT_TIMEZONE,
  type MyBarbershopDto,
  type UpdateBarbershopDto,
  type UpdateBarbershopStatusDto,
} from './dto/barbershop.dto';

/** Campos que se tratan como datos personales en la auditoría (solo el nombre del campo). */
const PERSONAL_FIELDS = ['phone', 'ruc'] as const;
const REQUIRED_FIELDS = ['name', 'address', 'latitude', 'longitude', 'phone', 'timezone'] as const;

type AuditableBarbershop = Pick<
  Barbershop,
  | 'name'
  | 'description'
  | 'address'
  | 'latitude'
  | 'longitude'
  | 'timezone'
  | 'phone'
  | 'ruc'
  | 'websiteUrl'
  | 'instagramUrl'
  | 'facebookUrl'
>;

export function toPublicDto(shop: Barbershop): BarbershopPublicDto {
  return {
    id: shop.id,
    name: shop.name,
    description: shop.description,
    address: shop.address,
    latitude: shop.latitude,
    longitude: shop.longitude,
    timezone: shop.timezone,
    phone: shop.phone,
    status: shop.status,
    closure:
      shop.status === 'TEMPORARILY_CLOSED'
        ? { reason: shop.closureReason, expectedReopenAt: shop.expectedReopenAt }
        : null,
    links: { website: shop.websiteUrl, instagram: shop.instagramUrl, facebook: shop.facebookUrl },
    rating: { average: Number(shop.ratingAvg), count: shop.ratingCount },
  };
}

function toManageDto(shop: Barbershop, myRole: BarbershopMemberRole): BarbershopManageDto {
  return { ...toPublicDto(shop), ruc: shop.ruc, myRole, createdAt: shop.createdAt };
}

const notFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'La barbería no existe.', HttpStatus.NOT_FOUND);

@Injectable()
export class BarbershopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly bookings: BookingsReadService,
    private readonly audit: AuditService,
  ) {}

  /**
   * RF-BAR-001. Quien registra queda como OWNER de la barbería y recibe el rol global OWNER.
   * Si `barbershops.require_review` es true, queda en PENDING_REVIEW (no visible) hasta que
   * soporte la apruebe (Fase 12).
   */
  async create(
    userId: string,
    dto: CreateBarbershopDto,
    ip: string | null,
  ): Promise<CreatedBarbershopDto> {
    const requireReview = await this.settings.boolean(SettingKey.BARBERSHOPS_REQUIRE_REVIEW, false);
    const credentials = await this.users.findCredentialsById(userId);
    const ownerRoleGranted = !credentials?.roles.includes('OWNER');

    const shop = await this.prisma.$transaction(async (tx) => {
      const created = await tx.barbershop.create({
        data: {
          name: dto.name,
          description: dto.description ?? null,
          address: dto.address,
          latitude: dto.latitude,
          longitude: dto.longitude,
          timezone: dto.timezone ?? DEFAULT_TIMEZONE,
          phone: dto.phone,
          ruc: dto.ruc ?? null,
          websiteUrl: dto.websiteUrl ?? null,
          instagramUrl: dto.instagramUrl ?? null,
          facebookUrl: dto.facebookUrl ?? null,
          status: requireReview ? 'PENDING_REVIEW' : 'OPEN',
          members: { create: { userId, role: 'OWNER' } },
        },
      });
      await this.users.addRole(userId, 'OWNER', tx);
      await this.audit.record(
        {
          actorId: userId,
          action: 'barbershop.created',
          entityType: 'barbershop',
          entityId: created.id,
          changes: { values: { status: { from: null, to: created.status } } },
          ip,
        },
        tx,
      );
      return created;
    });
    return { ...toManageDto(shop, 'OWNER'), ownerRoleGranted };
  }

  /** RF-BAR-002: consulta pública (solo barberías visibles). */
  async findPublic(id: string): Promise<BarbershopPublicDto> {
    const shop = await this.prisma.barbershop.findFirst({ where: publicBarbershopWhere(id) });
    if (!shop) throw notFound();
    return toPublicDto(shop);
  }

  async findManaged(userId: string, id: string): Promise<BarbershopManageDto> {
    const membership = await this.access.requireMember(userId, id);
    const shop = await this.prisma.barbershop.findUniqueOrThrow({ where: { id } });
    return toManageDto(shop, membership.role);
  }

  async listMine(userId: string, query: PaginationQueryDto): Promise<Page<MyBarbershopDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.barbershopMember.findMany({
      where: { userId, barbershop: { deletedAt: null }, ...args.where },
      orderBy: args.orderBy,
      take: args.take,
      include: { barbershop: { select: { id: true, name: true, status: true } } },
    });
    return toPage(rows, query, (m) => ({
      id: m.barbershop.id,
      name: m.barbershop.name,
      status: m.barbershop.status,
      myRole: m.role,
    }));
  }

  /** RF-BAR-003. OWNER o MANAGER de esa barbería. */
  async update(
    userId: string,
    id: string,
    dto: UpdateBarbershopDto,
    ip: string | null,
  ): Promise<BarbershopManageDto> {
    const membership = await this.access.requireMember(userId, id);
    for (const field of REQUIRED_FIELDS) {
      if ((dto as Record<string, unknown>)[field] === null) {
        throw new AppException(
          ErrorCode.VALIDATION_ERROR,
          'Los datos enviados no son válidos.',
          HttpStatus.BAD_REQUEST,
          [{ field, constraints: ['isNotEmpty'] }],
        );
      }
    }

    const before = await this.prisma.barbershop.findUniqueOrThrow({ where: { id } });
    const data: Prisma.BarbershopUpdateInput = {
      name: dto.name,
      description: dto.description,
      address: dto.address,
      latitude: dto.latitude,
      longitude: dto.longitude,
      timezone: dto.timezone,
      phone: dto.phone,
      ruc: dto.ruc,
      websiteUrl: dto.websiteUrl,
      instagramUrl: dto.instagramUrl,
      facebookUrl: dto.facebookUrl,
    };
    const changes = auditChanges<AuditableBarbershop>(
      before,
      data as Partial<AuditableBarbershop>,
      PERSONAL_FIELDS,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.barbershop.update({ where: { id }, data });
      if (changes) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'barbershop.updated',
            entityType: 'barbershop',
            entityId: id,
            changes,
            ip,
          },
          tx,
        );
      }
      return shop;
    });
    return toManageDto(updated, membership.role);
  }

  /**
   * RF-BAR-004. Solo el OWNER alterna entre OPEN y TEMPORARILY_CLOSED. PENDING_REVIEW y
   * SUSPENDED los gestiona soporte (Fase 12).
   */
  async updateStatus(
    userId: string,
    id: string,
    dto: UpdateBarbershopStatusDto,
    ip: string | null,
  ): Promise<BarbershopManageDto> {
    const membership = await this.access.requireMember(userId, id, ['OWNER']);
    const before = await this.prisma.barbershop.findUniqueOrThrow({ where: { id } });
    if (before.status === 'PENDING_REVIEW' || before.status === 'SUSPENDED') {
      throw new AppException(
        ErrorCode.STATUS_CHANGE_NOT_ALLOWED,
        before.status === 'PENDING_REVIEW'
          ? 'La barbería está en revisión. Soporte debe aprobarla antes de cambiar su estado.'
          : 'La barbería está suspendida. Contacta a soporte.',
        HttpStatus.CONFLICT,
      );
    }
    if (dto.expectedReopenAt && dto.expectedReopenAt <= new Date()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'expectedReopenAt', constraints: ['isFuture'] }],
      );
    }

    const closing = dto.status === 'TEMPORARILY_CLOSED';
    const updated = await this.prisma.$transaction(async (tx) => {
      const shop = await tx.barbershop.update({
        where: { id },
        data: {
          status: dto.status,
          closureReason: closing ? (dto.reason ?? null) : null,
          expectedReopenAt: closing ? (dto.expectedReopenAt ?? null) : null,
        },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'barbershop.status_changed',
          entityType: 'barbershop',
          entityId: id,
          changes: { values: { status: { from: before.status, to: shop.status } } },
          ip,
        },
        tx,
      );
      return shop;
    });
    return toManageDto(updated, membership.role);
  }

  /** Borrado lógico (solo OWNER), rechazado si hay reservas futuras activas. */
  async remove(userId: string, id: string, ip: string | null): Promise<void> {
    await this.access.requireMember(userId, id, ['OWNER']);
    await this.prisma.$transaction(async (tx) => {
      if (await this.bookings.hasFutureActive({ barbershopId: id }, tx)) {
        throw new AppException(
          ErrorCode.HAS_FUTURE_BOOKINGS,
          'La barbería tiene reservas futuras activas. Gestiónalas antes de eliminarla.',
          HttpStatus.CONFLICT,
        );
      }
      await tx.barbershop.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record(
        {
          actorId: userId,
          action: 'barbershop.deleted',
          entityType: 'barbershop',
          entityId: id,
          ip,
        },
        tx,
      );
    });
  }
}
