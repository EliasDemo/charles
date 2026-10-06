import { HttpStatus, Injectable } from '@nestjs/common';
import { auditChanges } from '../../common/audit/audit-diff';
import { AuditService } from '../../common/audit/audit.service';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  type Page,
  type PaginationQueryDto,
  pageArgs,
  toPage,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { BookingsReadService } from '../bookings/bookings-read.service';
import { ServicesService } from '../services/services.service';
import { UsersService } from '../users/users.service';
import type {
  BarberManageDto,
  BarberPublicDto,
  CreateBarberDto,
  LinkSelfAsBarberDto,
  MyBarberProfilesDto,
  UpdateBarberDto,
} from './dto/barber.dto';

/** Nombre, biografía y teléfono son datos personales: en auditoría, solo el nombre del campo. */
const PERSONAL_FIELDS = ['displayName', 'bio', 'phone'] as const;

const barberNotFound = (): AppException =>
  new AppException(ErrorCode.NOT_FOUND, 'El barbero no existe.', HttpStatus.NOT_FOUND);

const activeElsewhere = (): AppException =>
  new AppException(
    ErrorCode.BARBER_ALREADY_ACTIVE_ELSEWHERE,
    'Esta cuenta ya es barbero en una barbería. En esta etapa, un barbero trabaja en una sola barbería.',
    HttpStatus.CONFLICT,
  );

const independentLimit = (): AppException =>
  new AppException(
    ErrorCode.INDEPENDENT_SINGLE_BARBER,
    'Un barbero independiente tiene un solo barbero activo.',
    HttpStatus.CONFLICT,
  );

const barberWithServices = {
  services: {
    where: { service: { deletedAt: null } },
    select: { serviceId: true, service: { select: { isAvailable: true } } },
  },
} as const;

type BarberRow = Prisma.BarberGetPayload<{ include: typeof barberWithServices }>;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class BarbersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly services: ServicesService,
    private readonly bookings: BookingsReadService,
    private readonly users: UsersService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  /** Barberos activos de una barbería visible, solo con datos públicos. */
  async listPublic(
    barbershopId: string,
    query: PaginationQueryDto,
  ): Promise<Page<BarberPublicDto>> {
    await this.access.requirePublic(barbershopId);
    const args = pageArgs(query);
    const rows = await this.prisma.barber.findMany({
      where: { barbershopId, deletedAt: null, isActive: true, ...args.where },
      orderBy: args.orderBy,
      take: args.take,
      include: barberWithServices,
    });
    return toPage(rows, query, (b) => this.toPublic(b, true));
  }

  async listManaged(
    userId: string,
    barbershopId: string,
    query: PaginationQueryDto,
  ): Promise<Page<BarberManageDto>> {
    await this.access.requireMember(userId, barbershopId);
    const args = pageArgs(query);
    const rows = await this.prisma.barber.findMany({
      where: { barbershopId, deletedAt: null, ...args.where },
      orderBy: args.orderBy,
      take: args.take,
      include: barberWithServices,
    });
    const names = await this.users.fullNames(rows.flatMap((b) => (b.userId ? [b.userId] : [])));
    return toPage(rows, query, (b) => this.toManage(b, names));
  }

  /** RF-BRB-001. OWNER o MANAGER. */
  async create(
    userId: string,
    barbershopId: string,
    dto: CreateBarberDto,
    ip: string | null,
  ): Promise<BarberManageDto> {
    await this.access.requireMember(userId, barbershopId);
    return this.createProfile(userId, barbershopId, null, dto.displayName, dto, ip);
  }

  /** El responsable que también es barbero se vincula a sí mismo, sin invitación. */
  async linkSelf(
    userId: string,
    barbershopId: string,
    dto: LinkSelfAsBarberDto,
    ip: string | null,
  ): Promise<BarberManageDto> {
    await this.access.requireMember(userId, barbershopId);
    const credentials = await this.users.findCredentialsById(userId);
    const displayName = dto.displayName ?? credentials?.fullName ?? 'Barbero';
    try {
      return await this.createProfile(userId, barbershopId, userId, displayName, dto, ip);
    } catch (error) {
      if (isUniqueViolation(error)) throw activeElsewhere();
      throw error;
    }
  }

  /** RF-BRB-002. Desactivar se rechaza si el barbero tiene reservas futuras activas. */
  async update(
    userId: string,
    barbershopId: string,
    barberId: string,
    dto: UpdateBarberDto,
    ip: string | null,
  ): Promise<BarberManageDto> {
    await this.access.requireMember(userId, barbershopId);
    const before = await this.findOwned(barbershopId, barberId);
    if (dto.displayName === null) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'displayName', constraints: ['isNotEmpty'] }],
      );
    }
    const data = {
      displayName: dto.displayName,
      bio: dto.bio,
      phoneEnc:
        dto.phone === undefined
          ? undefined
          : this.encryption.encryptNullable(dto.phone, EncryptedField.BARBER_PHONE),
      isActive: dto.isActive,
    };
    // El teléfono se compara en claro (el cifrado cambia siempre por el IV aleatorio).
    const changes = auditChanges(
      {
        displayName: before.displayName,
        bio: before.bio,
        phone: this.encryption.decryptNullable(before.phoneEnc, EncryptedField.BARBER_PHONE),
        isActive: before.isActive,
      },
      { displayName: dto.displayName, bio: dto.bio, phone: dto.phone, isActive: dto.isActive },
      PERSONAL_FIELDS,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.isActive === false && before.isActive) {
        if (await this.bookings.hasFutureActive({ barberId }, tx)) {
          throw new AppException(
            ErrorCode.HAS_FUTURE_BOOKINGS,
            'El barbero tiene reservas futuras activas. Gestiónalas antes de desactivarlo.',
            HttpStatus.CONFLICT,
          );
        }
      }
      if (dto.isActive === true && !before.isActive) {
        await this.assertIndependentAllowsActive(tx, barbershopId, barberId);
      }
      const barber = await tx.barber.update({
        where: { id: barberId },
        data,
        include: barberWithServices,
      });
      if (barber.userId && dto.isActive !== undefined && dto.isActive !== before.isActive) {
        await this.syncBarberRole(barber.userId, tx);
      }
      if (changes) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'barber.updated',
            entityType: 'barber',
            entityId: barberId,
            changes,
            ip,
          },
          tx,
        );
      }
      return barber;
    });
    const names = await this.users.fullNames(updated.userId ? [updated.userId] : []);
    return this.toManage(updated, names);
  }

  /** Reemplaza el conjunto de servicios que realiza el barbero (solo de su barbería). */
  async setServices(
    userId: string,
    barbershopId: string,
    barberId: string,
    serviceIds: string[],
    ip: string | null,
  ): Promise<BarberManageDto> {
    await this.access.requireMember(userId, barbershopId);
    const before = await this.findOwned(barbershopId, barberId);
    const previous = before.services.map((s) => s.serviceId).sort();
    const next = [...new Set(serviceIds)].sort();

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.services.assertBelongTo(barbershopId, next, tx);
      await tx.barberService.deleteMany({ where: { barberId, serviceId: { notIn: next } } });
      await tx.barberService.createMany({
        data: next.map((serviceId) => ({ barberId, serviceId })),
        skipDuplicates: true,
      });
      if (previous.join() !== next.join()) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'barber.services_changed',
            entityType: 'barber',
            entityId: barberId,
            changes: { values: { serviceIds: { from: previous, to: next } } },
            ip,
          },
          tx,
        );
      }
      return tx.barber.findUniqueOrThrow({ where: { id: barberId }, include: barberWithServices });
    });
    const names = await this.users.fullNames(updated.userId ? [updated.userId] : []);
    return this.toManage(updated, names);
  }

  /** Para invitar: el barbero debe existir en la barbería y no tener cuenta vinculada. */
  async assertInvitable(barbershopId: string, barberId: string): Promise<void> {
    const barber = await this.findOwned(barbershopId, barberId);
    if (barber.userId) {
      throw new AppException(
        ErrorCode.BARBER_ALREADY_LINKED,
        'Este barbero ya tiene una cuenta vinculada.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** ¿Se puede vincular ya esta cuenta a este barbero? (lo usa el envío de invitaciones). */
  async canLink(barbershopId: string, barberId: string, userId: string): Promise<boolean> {
    const [barber, activeProfiles] = await Promise.all([
      this.prisma.barber.findFirst({
        where: { id: barberId, barbershopId, deletedAt: null, userId: null },
        select: { id: true },
      }),
      this.prisma.barber.count({ where: { userId, deletedAt: null } }),
    ]);
    return barber !== null && activeProfiles === 0;
  }

  /**
   * Rol global BARBER: lo tiene quien está vinculado a al menos un perfil de barbero activo y no
   * eliminado; si deja de estarlo (desactivado o eliminado), se retira.
   */
  async syncBarberRole(userId: string, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    const active = await tx.barber.count({ where: { userId, isActive: true, deletedAt: null } });
    if (active > 0) await this.users.addRole(userId, 'BARBER', tx);
    else await this.users.removeRole(userId, 'BARBER', tx);
  }

  /**
   * Al eliminar una barbería, sus barberos se eliminan con ella (borrado lógico): sus cuentas
   * quedan libres para vincularse a otra barbería y pierden el rol BARBER si no tienen otro perfil.
   */
  async removeAllOfBarbershop(barbershopId: string, tx: Prisma.TransactionClient): Promise<void> {
    const linked = await tx.barber.findMany({
      where: { barbershopId, deletedAt: null, userId: { not: null } },
      select: { userId: true },
    });
    await tx.barber.updateMany({
      where: { barbershopId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    for (const { userId } of linked) if (userId) await this.syncBarberRole(userId, tx);
  }

  /** Barberos activos que realizan cada servicio, por lotes (para el motor de disponibilidad). */
  async activeBarbersByService(serviceIds: string[]): Promise<Map<string, string[]>> {
    const rows = await this.prisma.barberService.findMany({
      where: { serviceId: { in: serviceIds }, barber: { isActive: true, deletedAt: null } },
      select: { serviceId: true, barberId: true },
    });
    const result = new Map<string, string[]>();
    for (const r of rows) result.set(r.serviceId, [...(result.get(r.serviceId) ?? []), r.barberId]);
    return result;
  }

  /** Barbero de la barbería (no eliminado) con su cuenta vinculada, o null. */
  async findInBarbershop(
    barbershopId: string,
    barberId: string,
  ): Promise<{ id: string; userId: string | null; isActive: boolean } | null> {
    return this.prisma.barber.findFirst({
      where: { id: barberId, barbershopId, deletedAt: null },
      select: { id: true, userId: true, isActive: true },
    });
  }

  /** Perfil de barbero activo de una cuenta en una barbería (para que gestione sus bloqueos). */
  async linkedBarberIdOf(barbershopId: string, userId: string): Promise<string | null> {
    const barber = await this.prisma.barber.findFirst({
      where: { barbershopId, userId, deletedAt: null },
      select: { id: true },
    });
    return barber?.id ?? null;
  }

  /**
   * Perfiles de barbero de la cuenta (activos o no, sin los eliminados ni los de barberías
   * eliminadas), con su barbería. Solo los del propio usuario.
   */
  async myProfiles(userId: string): Promise<MyBarberProfilesDto> {
    const rows = await this.prisma.barber.findMany({
      where: { userId, deletedAt: null, barbershop: { deletedAt: null } },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        displayName: true,
        isActive: true,
        services: {
          where: { service: { deletedAt: null } },
          select: { serviceId: true },
        },
        barbershop: { select: { id: true, name: true, status: true, timezone: true } },
      },
    });
    return {
      items: rows.map((r) => ({
        barberId: r.id,
        displayName: r.displayName,
        isActive: r.isActive,
        serviceIds: r.services.map((s) => s.serviceId),
        barbershop: r.barbershop,
      })),
    };
  }

  /** Perfiles de barbero activos (no eliminados) de la cuenta, con su barbería. */
  async activeProfilesOfUser(userId: string): Promise<{ id: string; barbershopId: string }[]> {
    return this.prisma.barber.findMany({
      where: { userId, isActive: true, deletedAt: null },
      select: { id: true, barbershopId: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Perfiles de barbero (no eliminados) vinculados a la cuenta. */
  async barberIdsOfUser(userId: string): Promise<string[]> {
    const rows = await this.prisma.barber.findMany({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async idsOfBarbershop(barbershopId: string): Promise<string[]> {
    const rows = await this.prisma.barber.findMany({
      where: { barbershopId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async displayNames(ids: string[]): Promise<Map<string, string>> {
    const barbers = await this.prisma.barber.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(barbers.map((b) => [b.id, b.displayName]));
  }

  /** Vincula la cuenta al aceptar una invitación (dentro de la transacción de aceptación). */
  async linkFromInvitation(
    tx: Prisma.TransactionClient,
    barbershopId: string,
    barberId: string,
    userId: string,
    invitedById: string,
  ): Promise<void> {
    const barber = await tx.barber.findFirst({
      where: { id: barberId, barbershopId, deletedAt: null },
      select: { userId: true },
    });
    if (!barber || barber.userId) {
      throw new AppException(
        ErrorCode.INVITATION_NO_LONGER_VALID,
        'La invitación ya no es válida. Pide al responsable que te invite nuevamente.',
        HttpStatus.CONFLICT,
      );
    }
    if ((await tx.barber.count({ where: { userId, deletedAt: null } })) > 0)
      throw activeElsewhere();

    await tx.barber.update({ where: { id: barberId }, data: { userId } });
    await this.users.addRole(userId, 'BARBER', tx);
    await this.audit.record(
      {
        actorId: userId,
        action: 'barber.account_linked',
        entityType: 'barber',
        entityId: barberId,
        changes: { userId, invitedBy: invitedById },
      },
      tx,
    );
  }

  private async createProfile(
    actorId: string,
    barbershopId: string,
    linkedUserId: string | null,
    displayName: string,
    dto: { bio?: string | null; phone?: string | null; serviceIds?: string[] },
    ip: string | null,
  ): Promise<BarberManageDto> {
    const barber = await this.prisma.$transaction(async (tx) => {
      if (
        linkedUserId &&
        (await tx.barber.count({ where: { userId: linkedUserId, deletedAt: null } })) > 0
      ) {
        throw activeElsewhere();
      }
      await this.assertIndependentAllowsActive(tx, barbershopId);
      if (dto.serviceIds?.length)
        await this.services.assertBelongTo(barbershopId, dto.serviceIds, tx);
      const created = await tx.barber.create({
        data: {
          barbershopId,
          userId: linkedUserId,
          displayName,
          bio: dto.bio ?? null,
          phoneEnc: this.encryption.encryptNullable(dto.phone, EncryptedField.BARBER_PHONE),
          services: {
            create: [...new Set(dto.serviceIds ?? [])].map((serviceId) => ({ serviceId })),
          },
        },
        include: barberWithServices,
      });
      if (linkedUserId) await this.users.addRole(linkedUserId, 'BARBER', tx);
      await this.audit.record(
        {
          actorId,
          action: linkedUserId ? 'barber.self_linked' : 'barber.created',
          entityType: 'barber',
          entityId: created.id,
          changes: { barbershopId, values: { isActive: { from: null, to: true } } },
          ip,
        },
        tx,
      );
      return created;
    });
    const names = await this.users.fullNames(linkedUserId ? [linkedUserId] : []);
    return this.toManage(barber, names);
  }

  /**
   * Perfil del barbero independiente, vinculado a su cuenta, dentro de la transacción que crea
   * la barbería.
   */
  async createIndependentProfile(
    tx: Prisma.TransactionClient,
    input: {
      barbershopId: string;
      userId: string;
      displayName: string;
      bio: string | null;
      ip: string | null;
    },
  ): Promise<{ barberId: string }> {
    if ((await tx.barber.count({ where: { userId: input.userId, deletedAt: null } })) > 0)
      throw activeElsewhere();
    const created = await tx.barber.create({
      data: {
        barbershopId: input.barbershopId,
        userId: input.userId,
        displayName: input.displayName,
        bio: input.bio,
      },
      select: { id: true },
    });
    await this.users.addRole(input.userId, 'BARBER', tx);
    await this.audit.record(
      {
        actorId: input.userId,
        action: 'barber.self_linked',
        entityType: 'barber',
        entityId: created.id,
        changes: {
          barbershopId: input.barbershopId,
          values: { isActive: { from: null, to: true } },
        },
        ip: input.ip,
      },
      tx,
    );
    return { barberId: created.id };
  }

  /**
   * Una barbería INDEPENDENT admite un solo barbero activo. Bloquea la fila de la barbería para
   * serializar altas y reactivaciones concurrentes (el trigger de la base es la red de respaldo).
   */
  private async assertIndependentAllowsActive(
    tx: Prisma.TransactionClient,
    barbershopId: string,
    exceptBarberId?: string,
  ): Promise<void> {
    const [shop] = await tx.$queryRaw<{ type: string }[]>`
      SELECT "type"::text AS "type" FROM "barbershops" WHERE "id" = ${barbershopId}::uuid FOR UPDATE`;
    if (shop?.type !== 'INDEPENDENT') return;
    const others = await tx.barber.count({
      where: {
        barbershopId,
        isActive: true,
        deletedAt: null,
        ...(exceptBarberId ? { id: { not: exceptBarberId } } : {}),
      },
    });
    if (others > 0) throw independentLimit();
  }

  private async findOwned(barbershopId: string, barberId: string): Promise<BarberRow> {
    const barber = await this.prisma.barber.findFirst({
      where: { id: barberId, barbershopId, deletedAt: null },
      include: barberWithServices,
    });
    if (!barber) throw barberNotFound();
    return barber;
  }

  private toPublic(barber: BarberRow, onlyAvailableServices: boolean): BarberPublicDto {
    return {
      id: barber.id,
      displayName: barber.displayName,
      bio: barber.bio,
      photoUrl: barber.photoUrl,
      serviceIds: barber.services
        .filter((s) => !onlyAvailableServices || s.service.isAvailable)
        .map((s) => s.serviceId),
      rating: { average: Number(barber.ratingAvg), count: barber.ratingCount },
    };
  }

  private toManage(barber: BarberRow, names: Map<string, string>): BarberManageDto {
    return {
      ...this.toPublic(barber, false),
      phone: this.encryption.decryptNullable(barber.phoneEnc, EncryptedField.BARBER_PHONE),
      isActive: barber.isActive,
      linkedUser: barber.userId
        ? { id: barber.userId, fullName: names.get(barber.userId) ?? '' }
        : null,
    };
  }
}
