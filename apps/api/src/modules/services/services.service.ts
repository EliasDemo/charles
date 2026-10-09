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
import { Prisma, type Service } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import {
  type CreateServiceDto,
  SERVICE_CURRENCY,
  type ServiceManageDto,
  type ServicePublicDto,
  type UpdateServiceDto,
} from './dto/service.dto';

const REQUIRED_FIELDS = [
  'name',
  'priceAmount',
  'durationMinutes',
  'isAvailable',
  'categoryKey',
] as const;

type AuditableService = Pick<
  Service,
  'name' | 'description' | 'priceAmount' | 'durationMinutes' | 'isAvailable' | 'categoryId'
>;

const withCategory = { category: { select: { key: true, name: true } } } as const;
type ServiceRow = Service & { category: { key: string; name: string } };

const invalidCategory = (): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field: 'categoryKey', constraints: ['activeCategory'] }],
  );

const serviceNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El servicio no existe.', HttpStatus.NOT_FOUND);

function toPublicDto(service: ServiceRow): ServicePublicDto {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price: { amount: service.priceAmount, currency: service.currency },
    durationMinutes: service.durationMinutes,
    category: { key: service.category.key, name: service.category.name },
  };
}

export interface AdminCategory {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  servicesCount: number;
}

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly audit: AuditService,
  ) {}

  /** RF-SER-003: servicios disponibles de una barbería visible. */
  async listPublic(
    barbershopId: string,
    query: PaginationQueryDto,
  ): Promise<Page<ServicePublicDto>> {
    await this.access.requirePublic(barbershopId);
    const args = pageArgs(query);
    const rows = await this.prisma.service.findMany({
      where: { barbershopId, deletedAt: null, isAvailable: true, ...args.where },
      orderBy: args.orderBy,
      take: args.take,
      include: withCategory,
    });
    return toPage(rows, query, toPublicDto);
  }

  async listManaged(
    userId: string,
    barbershopId: string,
    query: PaginationQueryDto,
  ): Promise<Page<ServiceManageDto>> {
    await this.access.requireMember(userId, barbershopId);
    const args = pageArgs(query);
    const rows = await this.prisma.service.findMany({
      where: { barbershopId, deletedAt: null, ...args.where },
      orderBy: args.orderBy,
      take: args.take,
      include: {
        ...withCategory,
        barbers: { where: { barber: { deletedAt: null } }, select: { barberId: true } },
      },
    });
    return toPage(rows, query, (s) => ({
      ...toPublicDto(s),
      isAvailable: s.isAvailable,
      barberIds: s.barbers.map((b) => b.barberId),
    }));
  }

  /** RF-SER-001. OWNER o MANAGER. */
  async create(
    userId: string,
    barbershopId: string,
    dto: CreateServiceDto,
    ip: string | null,
  ): Promise<ServiceManageDto> {
    await this.access.requireMember(userId, barbershopId);
    const categoryId = await this.activeCategoryId(dto.categoryKey);
    const service = await this.prisma.$transaction(async (tx) => {
      const created = await tx.service.create({
        data: {
          barbershopId,
          name: dto.name,
          description: dto.description ?? null,
          priceAmount: dto.priceAmount,
          currency: SERVICE_CURRENCY,
          durationMinutes: dto.durationMinutes,
          isAvailable: dto.isAvailable ?? true,
          categoryId,
        },
        include: withCategory,
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'service.created',
          entityType: 'service',
          entityId: created.id,
          changes: {
            barbershopId,
            values: {
              priceAmount: { from: null, to: created.priceAmount },
              durationMinutes: { from: null, to: created.durationMinutes },
              category: { from: null, to: created.category.key },
            },
          },
          ip,
        },
        tx,
      );
      return created;
    });
    return { ...toPublicDto(service), isAvailable: service.isAvailable, barberIds: [] };
  }

  /** RF-SER-002. Precio y duración se auditan con valor anterior y nuevo. */
  async update(
    userId: string,
    barbershopId: string,
    serviceId: string,
    dto: UpdateServiceDto,
    ip: string | null,
  ): Promise<ServiceManageDto> {
    await this.access.requireMember(userId, barbershopId);
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
    const before = await this.findOwned(barbershopId, serviceId);
    const categoryId =
      dto.categoryKey === undefined ? undefined : await this.activeCategoryId(dto.categoryKey);
    const data: Prisma.ServiceUncheckedUpdateInput = {
      name: dto.name,
      description: dto.description,
      priceAmount: dto.priceAmount,
      durationMinutes: dto.durationMinutes,
      isAvailable: dto.isAvailable,
      categoryId,
    };
    const changes = auditChanges<AuditableService>(before, data as Partial<AuditableService>);

    const updated = await this.prisma.$transaction(async (tx) => {
      const service = await tx.service.update({
        where: { id: serviceId },
        data,
        include: {
          ...withCategory,
          barbers: { where: { barber: { deletedAt: null } }, select: { barberId: true } },
        },
      });
      if (changes) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'service.updated',
            entityType: 'service',
            entityId: serviceId,
            changes,
            ip,
          },
          tx,
        );
      }
      return service;
    });
    return {
      ...toPublicDto(updated),
      isAvailable: updated.isAvailable,
      barberIds: updated.barbers.map((b) => b.barberId),
    };
  }

  /** Borrado lógico: deja de mostrarse y de poder reservarse. */
  async remove(
    userId: string,
    barbershopId: string,
    serviceId: string,
    ip: string | null,
  ): Promise<void> {
    await this.access.requireMember(userId, barbershopId);
    await this.findOwned(barbershopId, serviceId);
    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({ where: { id: serviceId }, data: { deletedAt: new Date() } });
      await this.audit.record(
        {
          actorId: userId,
          action: 'service.deleted',
          entityType: 'service',
          entityId: serviceId,
          ip,
        },
        tx,
      );
    });
  }

  // ───────────── Categorías (ADMIN, Fase 12) ─────────────

  /** Todas, incluidas las inactivas, con cuántos servicios las usan. */
  async listAllCategories(): Promise<AdminCategory[]> {
    const rows = await this.prisma.serviceCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      include: { _count: { select: { services: { where: { deletedAt: null } } } } },
    });
    return rows.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      sortOrder: c.sortOrder,
      isActive: c.isActive,
      servicesCount: c._count.services,
    }));
  }

  async createCategory(input: { key: string; name: string; sortOrder: number }): Promise<string> {
    try {
      const created = await this.prisma.serviceCategory.create({
        data: input,
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Ya existe una categoría con esa clave.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /**
   * Editar nombre, orden o estado. Nunca se borra: desactivar la saca de la lista pública y de los
   * servicios nuevos; los servicios que ya la usan la conservan.
   */
  async updateCategory(
    id: string,
    input: { name?: string; sortOrder?: number; isActive?: boolean },
  ): Promise<{ before: AdminCategory; after: AdminCategory }> {
    const before = (await this.listAllCategories()).find((c) => c.id === id);
    if (!before) {
      throw new AppException(ErrorCode.NOT_FOUND, 'La categoría no existe.', HttpStatus.NOT_FOUND);
    }
    await this.prisma.serviceCategory.update({ where: { id }, data: input });
    const after = (await this.listAllCategories()).find((c) => c.id === id)!;
    return { before, after };
  }

  /**
   * Clave de categoría de varios servicios en **una consulta** (incluye servicios eliminados: una
   * reserva antigua conserva su categoría).
   */
  async categoryKeysOf(serviceIds: string[]): Promise<Map<string, string>> {
    if (serviceIds.length === 0) return new Map();
    const rows = await this.prisma.service.findMany({
      where: { id: { in: [...new Set(serviceIds)] } },
      select: { id: true, category: { select: { key: true } } },
    });
    return new Map(rows.map((r) => [r.id, r.category.key]));
  }

  /** Categorías activas, en orden (público). */
  async listCategories(): Promise<{ items: { key: string; name: string }[] }> {
    const items = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
      select: { key: true, name: true },
    });
    return { items };
  }

  /** ID de una categoría activa por su clave (400 si no existe o está inactiva). */
  async activeCategoryId(key: string): Promise<string> {
    const id = await this.findActiveCategoryId(key);
    if (!id) throw invalidCategory();
    return id;
  }

  async findActiveCategoryId(key: string): Promise<string | null> {
    const category = await this.prisma.serviceCategory.findFirst({
      where: { key, isActive: true },
      select: { id: true },
    });
    return category?.id ?? null;
  }

  /** Datos públicos de servicios reservables (no eliminados y disponibles), por lotes. */
  async bookableSummaries(serviceIds: string[]): Promise<
    Map<
      string,
      {
        id: string;
        barbershopId: string;
        name: string;
        priceAmount: number;
        currency: string;
        durationMinutes: number;
        categoryKey: string;
      }
    >
  > {
    const rows = await this.prisma.service.findMany({
      where: { id: { in: serviceIds }, deletedAt: null, isAvailable: true },
      include: { category: { select: { key: true } } },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          barbershopId: r.barbershopId,
          name: r.name,
          priceAmount: r.priceAmount,
          currency: r.currency,
          durationMinutes: r.durationMinutes,
          categoryKey: r.category.key,
        },
      ]),
    );
  }

  /** Servicios disponibles (no eliminados) con su duración, por lotes. */
  async bookableDurations(
    serviceIds: string[],
  ): Promise<Map<string, { barbershopId: string; durationMinutes: number }>> {
    const rows = await this.prisma.service.findMany({
      where: { id: { in: serviceIds }, deletedAt: null, isAvailable: true },
      select: { id: true, barbershopId: true, durationMinutes: true },
    });
    return new Map(
      rows.map((r) => [r.id, { barbershopId: r.barbershopId, durationMinutes: r.durationMinutes }]),
    );
  }

  /** Valida que todos los servicios existan, no estén eliminados y sean de la barbería. */
  async assertBelongTo(
    barbershopId: string,
    serviceIds: string[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const unique = [...new Set(serviceIds)];
    const count = await tx.service.count({
      where: { id: { in: unique }, barbershopId, deletedAt: null },
    });
    if (count !== unique.length) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'serviceIds', constraints: ['serviceOfBarbershop'] }],
      );
    }
  }

  private async findOwned(barbershopId: string, serviceId: string): Promise<ServiceRow> {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, barbershopId, deletedAt: null },
      include: withCategory,
    });
    if (!service) throw serviceNotFound();
    return service;
  }
}
