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
