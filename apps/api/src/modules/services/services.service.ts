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
import type { Prisma, Service } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import {
  type CreateServiceDto,
  SERVICE_CURRENCY,
  type ServiceManageDto,
  type ServicePublicDto,
  type UpdateServiceDto,
} from './dto/service.dto';

const REQUIRED_FIELDS = ['name', 'priceAmount', 'durationMinutes', 'isAvailable'] as const;

type AuditableService = Pick<
  Service,
  'name' | 'description' | 'priceAmount' | 'durationMinutes' | 'isAvailable'
>;

const serviceNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El servicio no existe.', HttpStatus.NOT_FOUND);

function toPublicDto(service: Service): ServicePublicDto {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price: { amount: service.priceAmount, currency: service.currency },
    durationMinutes: service.durationMinutes,
  };
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
      include: { barbers: { where: { barber: { deletedAt: null } }, select: { barberId: true } } },
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
        },
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
    const data: Prisma.ServiceUpdateInput = {
      name: dto.name,
      description: dto.description,
      priceAmount: dto.priceAmount,
      durationMinutes: dto.durationMinutes,
      isAvailable: dto.isAvailable,
    };
    const changes = auditChanges<AuditableService>(before, data as Partial<AuditableService>);

    const updated = await this.prisma.$transaction(async (tx) => {
      const service = await tx.service.update({
        where: { id: serviceId },
        data,
        include: {
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

  private async findOwned(barbershopId: string, serviceId: string): Promise<Service> {
    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, barbershopId, deletedAt: null },
    });
    if (!service) throw serviceNotFound();
    return service;
  }
}
