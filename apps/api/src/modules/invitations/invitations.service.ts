import { randomInt, timingSafeEqual } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-user';
import { OneTimeCodePurpose } from '../../common/crypto/encryption-contexts';
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
import type { BarbershopMemberRole } from '../../generated/prisma/enums';
import type { RequestContext } from '../auth/auth.service';
import type { AcceptedResponseDto } from '../auth/dto/auth.dto';
import { LoginAttemptsService } from '../auth/login-attempts.service';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { MembersService } from '../barbershops/members.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import type { InvitationDto } from './dto/invitation.dto';
import { INVITATIONS_QUEUE, type InvitationJob } from './invitations.jobs';

/** Mismas reglas que los códigos de la Fase 3: 6 dígitos, un uso, vencimiento, máx. 5 intentos. */
export const INVITATION_POLICY = {
  digits: 6,
  defaultTtlMinutes: 15,
  maxAttempts: 5,
} as const;

/** Respuesta única al invitar, exista o no la cuenta (no permite averiguar qué correos existen). */
export const INVITATION_ACCEPTED: AcceptedResponseDto = {
  message:
    'Si el correo corresponde a una cuenta de Charles que puede recibir la invitación, le enviamos un código.',
};

const invalidCode = (): AppException =>
  new AppException(
    ErrorCode.INVALID_CODE,
    'El código no es válido o la invitación expiró. Pide una nueva invitación.',
    HttpStatus.BAD_REQUEST,
  );

const activeWhere = (now = new Date()): Prisma.BarbershopInvitationWhereInput => ({
  acceptedAt: null,
  revokedAt: null,
  expiresAt: { gt: now },
  attempts: { lt: INVITATION_POLICY.maxAttempts },
  barbershop: { deletedAt: null },
});

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly members: MembersService,
    private readonly barbers: BarbersService,
    private readonly users: UsersService,
    private readonly settings: SettingsService,
    private readonly encryption: EncryptionService,
    private readonly attempts: LoginAttemptsService,
    private readonly audit: AuditService,
    @InjectQueue(INVITATIONS_QUEUE) private readonly queue: Queue<InvitationJob>,
  ) {}

  /** Solo un OWNER invita responsables. */
  async inviteMember(
    actor: AuthUser,
    barbershopId: string,
    email: string,
    role: BarbershopMemberRole,
  ): Promise<AcceptedResponseDto> {
    await this.access.requireMember(actor.id, barbershopId, ['OWNER']);
    await this.queue.add('member', {
      type: 'member',
      barbershopId,
      role,
      emailHashHex: this.users.emailHash(email).toString('hex'),
      invitedById: actor.id,
    });
    return INVITATION_ACCEPTED;
  }

  /** OWNER o MANAGER invitan a vincular una cuenta a un perfil de barbero sin cuenta. */
  async inviteBarber(
    actor: AuthUser,
    barbershopId: string,
    barberId: string,
    email: string,
  ): Promise<AcceptedResponseDto> {
    await this.access.requireMember(actor.id, barbershopId);
    await this.barbers.assertInvitable(barbershopId, barberId);
    await this.queue.add('barber', {
      type: 'barber',
      barbershopId,
      barberId,
      emailHashHex: this.users.emailHash(email).toString('hex'),
      invitedById: actor.id,
    });
    return INVITATION_ACCEPTED;
  }

  /**
   * Crea la invitación (lo llama el worker). Revoca las pendientes equivalentes y devuelve el
   * código en claro solo para enviarlo por correo; en la base queda su HMAC.
   */
  async issue(
    job: InvitationJob,
    invitedUserId: string,
  ): Promise<{ code: string; invitationId: string; expiresAt: Date }> {
    const ttlMinutes = await this.settings.positiveInt(
      SettingKey.INVITATION_TTL_MINUTES,
      INVITATION_POLICY.defaultTtlMinutes,
    );
    const code = randomInt(0, 10 ** INVITATION_POLICY.digits)
      .toString()
      .padStart(INVITATION_POLICY.digits, '0');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);
    const sameTarget: Prisma.BarbershopInvitationWhereInput = {
      barbershopId: job.barbershopId,
      invitedUserId,
      kind: job.type === 'member' ? 'MEMBER' : 'BARBER',
      ...(job.type === 'barber' ? { barberId: job.barberId } : {}),
      acceptedAt: null,
      revokedAt: null,
    };

    const invitation = await this.prisma.$transaction(async (tx) => {
      await tx.barbershopInvitation.updateMany({ where: sameTarget, data: { revokedAt: now } });
      return tx.barbershopInvitation.create({
        data: {
          barbershopId: job.barbershopId,
          kind: job.type === 'member' ? 'MEMBER' : 'BARBER',
          memberRole: job.type === 'member' ? job.role : null,
          barberId: job.type === 'barber' ? job.barberId : null,
          invitedUserId,
          invitedById: job.invitedById,
          codeHash: this.hash(code, invitedUserId),
          expiresAt,
        },
        select: { id: true },
      });
    });
    return { code, invitationId: invitation.id, expiresAt };
  }

  /** Invitaciones pendientes de la cuenta autenticada. */
  async listMine(user: AuthUser, query: PaginationQueryDto): Promise<Page<InvitationDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.barbershopInvitation.findMany({
      where: { invitedUserId: user.id, ...activeWhere(), ...args.where },
      orderBy: args.orderBy,
      take: args.take,
    });
    const [shopNames, barberNames] = await Promise.all([
      this.access.names([...new Set(rows.map((i) => i.barbershopId))]),
      this.barbers.displayNames(rows.flatMap((i) => (i.barberId ? [i.barberId] : []))),
    ]);
    return toPage(rows, query, (i) => ({
      id: i.id,
      kind: i.kind,
      barbershopId: i.barbershopId,
      barbershopName: shopNames.get(i.barbershopId) ?? '',
      memberRole: i.memberRole,
      barberDisplayName: i.barberId ? (barberNames.get(i.barberId) ?? null) : null,
      expiresAt: i.expiresAt,
    }));
  }

  /**
   * Acepta con el código. Un fallo suma un intento (inválida al quinto) y cuenta para el
   * bloqueo por cuenta e IP, igual que los códigos de la Fase 3.
   */
  async accept(
    user: AuthUser,
    invitationId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<void> {
    const emailHash = await this.users.emailHashOf(user.id);
    if (!emailHash) throw invalidCode();
    const subject = { accountKey: emailHash.toString('hex'), ip: ctx.ip };
    await this.attempts.assertNotLocked(subject);

    const invitation = await this.prisma.barbershopInvitation.findFirst({
      where: { id: invitationId, invitedUserId: user.id, ...activeWhere() },
    });
    const expected = invitation ? Buffer.from(invitation.codeHash) : null;
    const received = this.hash(code, user.id);
    if (
      !invitation ||
      !expected ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      if (invitation) {
        await this.prisma.barbershopInvitation.updateMany({
          where: { id: invitation.id, attempts: { lt: INVITATION_POLICY.maxAttempts } },
          data: { attempts: { increment: 1 } },
        });
      }
      await this.attempts.recordFailure(subject);
      throw invalidCode();
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // Condicional: un solo uso aunque lleguen dos aceptaciones a la vez.
        const { count } = await tx.barbershopInvitation.updateMany({
          where: { id: invitation.id, ...activeWhere() },
          data: { acceptedAt: new Date() },
        });
        if (count === 0) throw invalidCode();

        if (invitation.kind === 'MEMBER' && invitation.memberRole) {
          await this.members.addFromInvitation(
            tx,
            invitation.barbershopId,
            user.id,
            invitation.memberRole,
            invitation.invitedById,
          );
        } else if (invitation.kind === 'BARBER' && invitation.barberId) {
          await this.barbers.linkFromInvitation(
            tx,
            invitation.barbershopId,
            invitation.barberId,
            user.id,
            invitation.invitedById,
          );
        }
        await this.audit.record(
          {
            actorId: user.id,
            action: 'barbershop.invitation_accepted',
            entityType: 'barbershop_invitation',
            entityId: invitation.id,
            ip: ctx.ip,
          },
          tx,
        );
      });
    } catch (error) {
      // Red de seguridad: el índice único impide ser barbero activo en dos barberías.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.BARBER_ALREADY_ACTIVE_ELSEWHERE,
          'Esta cuenta ya es barbero en una barbería. En esta etapa, un barbero trabaja en una sola barbería.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  private hash(code: string, userId: string): Buffer<ArrayBuffer> {
    return this.encryption.oneTimeCodeHash(code, OneTimeCodePurpose.BARBERSHOP_INVITATION, userId);
  }
}
