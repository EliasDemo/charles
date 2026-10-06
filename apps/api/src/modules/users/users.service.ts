import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { BlindIndexKind, EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { NotificationChannel, type Role, type UserStatus } from '../../generated/prisma/enums';
import type { ProfileDto, UpdateProfileDto } from './dto/profile.dto';

/** Canales activos por defecto mientras el usuario no elija los suyos. */
export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannel[] = [
  NotificationChannel.PUSH,
  NotificationChannel.EMAIL,
  NotificationChannel.IN_APP,
];

export interface NewClient {
  fullName: string;
  email: string;
  phone?: string | null;
  passwordHash: string;
  termsVersion: string;
}

/** Datos mínimos para autenticar. Nunca salen de los servicios de autenticación. */
export interface UserCredentials {
  id: string;
  passwordHash: string;
  status: UserStatus;
  isDeleted: boolean;
  emailVerified: boolean;
  fullName: string;
  roles: Role[];
}

type Tx = Prisma.TransactionClient;

export interface StaffUserView {
  id: string;
  fullName: string;
  status: UserStatus;
  roles: Role[];
  emailVerified: boolean;
  createdAt: Date;
  deleted: boolean;
}

/** Única puerta a la tabla `users` (CLAUDE.md §3: los módulos no tocan tablas ajenas). */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  emailHash(email: string): Buffer<ArrayBuffer> {
    return this.encryption.blindIndex(email, BlindIndexKind.EMAIL);
  }

  async findIdByEmailHash(emailHash: Uint8Array<ArrayBuffer>): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { emailHash }, select: { id: true } });
    return user?.id ?? null;
  }

  /**
   * Crea un usuario con rol CLIENT (RF-AUT-001). Devuelve `null` si el correo ya existe
   * (también ante una carrera entre dos registros simultáneos).
   */
  async createClient(data: NewClient, ip: string | null): Promise<string | null> {
    const now = new Date();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            emailEnc: this.encryption.encrypt(data.email, EncryptedField.USER_EMAIL),
            emailHash: this.emailHash(data.email),
            passwordHash: data.passwordHash,
            fullName: data.fullName,
            phoneEnc: this.encryption.encryptNullable(data.phone, EncryptedField.USER_PHONE),
            phoneHash: this.encryption.blindIndexNullable(data.phone, BlindIndexKind.PHONE),
            termsAcceptedAt: now,
            termsVersion: data.termsVersion,
            adultDeclaredAt: now,
            roles: { create: { role: 'CLIENT' } },
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: user.id,
            action: 'user.registered',
            entityType: 'user',
            entityId: user.id,
            ip,
          },
          tx,
        );
        return user.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  async findCredentialsByEmailHash(
    emailHash: Uint8Array<ArrayBuffer>,
  ): Promise<UserCredentials | null> {
    return this.findCredentials({ emailHash });
  }

  async findCredentialsById(id: string): Promise<UserCredentials | null> {
    return this.findCredentials({ id });
  }

  /** Correo en claro para enviar notificaciones. Solo para los procesos de envío. */
  async contactEmail(id: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { emailEnc: true, deletedAt: true },
    });
    if (!user || user.deletedAt) return null;
    return this.encryption.decrypt(user.emailEnc, EncryptedField.USER_EMAIL);
  }

  async emailHashOf(id: string): Promise<Buffer<ArrayBuffer> | null> {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { emailHash: true } });
    return user ? Buffer.from(user.emailHash) : null;
  }

  /** Agrega un rol global (idempotente). */
  async addRole(userId: string, role: Role, tx: Tx = this.prisma): Promise<void> {
    await tx.userRole.upsert({
      where: { userId_role: { userId, role } },
      update: {},
      create: { userId, role },
    });
  }

  async removeRole(userId: string, role: Role, tx: Tx = this.prisma): Promise<void> {
    await tx.userRole.deleteMany({ where: { userId, role } });
  }

  /** Fase 12: datos mínimos para soporte (nunca correo, teléfono ni documento). */
  async staffView(id: string): Promise<StaffUserView | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        fullName: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
        deletedAt: true,
        roles: { select: { role: true } },
      },
    });
    if (!user) return null;
    return {
      id: user.id,
      fullName: user.fullName,
      status: user.status,
      roles: user.roles.map((r) => r.role),
      emailVerified: user.emailVerifiedAt !== null,
      createdAt: user.createdAt,
      deleted: user.deletedAt !== null,
    };
  }

  /** Fase 10: estado y preferencias de notificación de varias cuentas. */
  async notificationTargets(
    ids: string[],
  ): Promise<
    { id: string; status: UserStatus; deleted: boolean; preferences: Prisma.JsonValue }[]
  > {
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, deletedAt: true, preferences: true },
    });
    return rows.map((u) => ({
      id: u.id,
      status: u.status,
      deleted: u.deletedAt !== null,
      preferences: u.preferences,
    }));
  }

  /** Fase 12: contacto en claro, solo para el acceso auditado de soporte. */
  async contact(id: string): Promise<{ email: string; phone: string | null } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { emailEnc: true, phoneEnc: true },
    });
    if (!user) return null;
    return {
      email: this.encryption.decrypt(user.emailEnc, EncryptedField.USER_EMAIL),
      phone: user.phoneEnc
        ? this.encryption.decrypt(user.phoneEnc, EncryptedField.USER_PHONE)
        : null,
    };
  }

  async setStatus(id: string, status: UserStatus, tx: Tx = this.prisma): Promise<void> {
    await tx.user.update({ where: { id }, data: { status } });
  }

  /** Cuentas activas (no eliminadas) con el rol, excluyendo opcionalmente una. */
  async countActiveWithRole(role: Role, excludeId?: string, tx: Tx = this.prisma): Promise<number> {
    return tx.userRole.count({
      where: {
        role,
        user: {
          status: 'ACTIVE',
          deletedAt: null,
          ...(excludeId ? { id: { not: excludeId } } : {}),
        },
      },
    });
  }

  /** Nombres visibles (no son datos sensibles cifrados) para listas de miembros. */
  async fullNames(ids: string[]): Promise<Map<string, string>> {
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  async markEmailVerified(id: string, tx: Tx = this.prisma): Promise<void> {
    await tx.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } });
  }

  async updatePasswordHash(id: string, passwordHash: string, tx: Tx = this.prisma): Promise<void> {
    await tx.user.update({ where: { id }, data: { passwordHash } });
  }

  /** RF-CLI-001: perfil de la cuenta autenticada. */
  async getProfile(id: string): Promise<ProfileDto | null> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { roles: { select: { role: true } } },
    });
    if (!user) return null;
    return {
      id: user.id,
      fullName: user.fullName,
      email: this.encryption.decrypt(user.emailEnc, EncryptedField.USER_EMAIL),
      emailVerified: user.emailVerifiedAt !== null,
      phone: this.encryption.decryptNullable(user.phoneEnc, EncryptedField.USER_PHONE),
      roles: user.roles.map((r) => r.role),
      preferences: {
        notificationChannels: notificationChannelsOf(user.preferences),
        reminders: !(isRecord(user.preferences) && user.preferences.reminders === false),
      },
      createdAt: user.createdAt,
    };
  }

  /** RF-CLI-002. Audita qué campos cambiaron, nunca sus valores. */
  async updateProfile(
    id: string,
    dto: UpdateProfileDto,
    ip: string | null,
  ): Promise<ProfileDto | null> {
    const current = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { preferences: true },
    });
    if (!current) return null;

    const data: Prisma.UserUpdateInput = {};
    const changed: string[] = [];
    if (dto.fullName !== undefined) {
      data.fullName = dto.fullName;
      changed.push('fullName');
    }
    if (dto.phone !== undefined) {
      data.phoneEnc = this.encryption.encryptNullable(dto.phone, EncryptedField.USER_PHONE);
      data.phoneHash = this.encryption.blindIndexNullable(dto.phone, BlindIndexKind.PHONE);
      changed.push('phone');
    }
    if (dto.preferences !== undefined) {
      const base = isRecord(current.preferences) ? current.preferences : {};
      data.preferences = {
        ...base,
        notificationChannels: dto.preferences.notificationChannels,
        ...(dto.preferences.reminders !== undefined
          ? { reminders: dto.preferences.reminders }
          : {}),
      };
      changed.push('preferences.notificationChannels');
    }

    if (changed.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data });
        await this.audit.record(
          {
            actorId: id,
            action: 'user.profile_updated',
            entityType: 'user',
            entityId: id,
            changes: { fields: changed },
            ip,
          },
          tx,
        );
      });
    }
    return this.getProfile(id);
  }

  private async findCredentials(
    where: Prisma.UserWhereUniqueInput,
  ): Promise<UserCredentials | null> {
    const user = await this.prisma.user.findUnique({
      where,
      select: {
        id: true,
        passwordHash: true,
        status: true,
        deletedAt: true,
        emailVerifiedAt: true,
        fullName: true,
        roles: { select: { role: true } },
      },
    });
    if (!user) return null;
    return {
      id: user.id,
      passwordHash: user.passwordHash,
      status: user.status,
      isDeleted: user.deletedAt !== null,
      emailVerified: user.emailVerifiedAt !== null,
      fullName: user.fullName,
      roles: user.roles.map((r) => r.role),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notificationChannelsOf(preferences: unknown): NotificationChannel[] {
  const valid = new Set<string>(Object.values(NotificationChannel));
  if (isRecord(preferences) && Array.isArray(preferences.notificationChannels)) {
    return preferences.notificationChannels.filter(
      (c): c is NotificationChannel => typeof c === 'string' && valid.has(c),
    );
  }
  return [...DEFAULT_NOTIFICATION_CHANNELS];
}
