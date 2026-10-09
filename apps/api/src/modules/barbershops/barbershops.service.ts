import { FavoritesService } from '../reviews/favorites.service';
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
import { type Barbershop, Prisma } from '../../generated/prisma/client';
import type { BarbershopMemberRole, BarbershopStatus } from '../../generated/prisma/enums';
import { BlindIndexKind, EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import {
  isValidOwnerDocument,
  maskDocument,
  missingRequirements,
  type ReviewRequirement,
  SUBMITTABLE_STATUSES,
  wasApproved,
} from './review-policy';

/** Marca para soporte: una barbería ya aprobada cambió el documento del responsable. */
export const OWNER_DOCUMENT_CHANGED_FLAG = 'owner_document_changed';
import { BarbersService } from '../barbers/barbers.service';
import { BookingsReadService } from '../bookings/bookings-read.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';
import { BarbershopAccessService, publicBarbershopWhere } from './barbershop-access.service';
import { MembersService } from './members.service';
import {
  type BarbershopManageDto,
  type BarbershopPublicDto,
  type BarbershopReviewDto,
  type CreateBarbershopDto,
  type CreatedBarbershopDto,
  type CreatedIndependentDto,
  type CreateIndependentDto,
  DEFAULT_TIMEZONE,
  type MyBarbershopDto,
  type OwnerDocumentInputDto,
  type OwnerDocumentViewDto,
  type UpdateBarbershopDto,
  type UpdateBarbershopStatusDto,
} from './dto/barbershop.dto';

/** Campos que se tratan como datos personales en la auditoría (solo el nombre del campo). */
const PERSONAL_FIELDS = ['phone'] as const;
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
  | 'websiteUrl'
  | 'instagramUrl'
  | 'facebookUrl'
>;

export function toPublicDto(shop: Barbershop): BarbershopPublicDto {
  return {
    isFavorite: false,
    id: shop.id,
    name: shop.name,
    description: shop.description,
    address: shop.address,
    latitude: shop.latitude,
    longitude: shop.longitude,
    timezone: shop.timezone,
    type: shop.type,
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

function toManageDto(
  shop: Barbershop,
  myRole: BarbershopMemberRole,
  ownerDocument: OwnerDocumentViewDto | null,
): BarbershopManageDto {
  return { ...toPublicDto(shop), ownerDocument, myRole, createdAt: shop.createdAt };
}

const invalidDocument = (): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field: 'ownerDocument.number', constraints: ['ownerDocument'] }],
  );

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
    private readonly members: MembersService,
    private readonly barbers: BarbersService,
    private readonly favorites: FavoritesService,
    private readonly encryption: EncryptionService,
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

    const shop = await this.prisma.$transaction((tx) =>
      this.createShop(tx, userId, dto, 'BARBERSHOP', requireReview, ip),
    );
    return { ...this.manage(shop, 'OWNER'), ownerRoleGranted };
  }

  /**
   * Barbero independiente: en una sola transacción crea la barbería INDEPENDENT, deja a la cuenta
   * como OWNER y la vincula como su único barbero activo. Se mantiene la regla de un barbero
   * activo en una sola barbería.
   */
  async createIndependent(
    userId: string,
    dto: CreateIndependentDto,
    ip: string | null,
  ): Promise<CreatedIndependentDto> {
    const requireReview = await this.settings.boolean(SettingKey.BARBERSHOPS_REQUIRE_REVIEW, false);
    const credentials = await this.users.findCredentialsById(userId);
    const roles = credentials?.roles ?? [];
    const { displayName, bio, ...shopData } = dto;

    try {
      const { shop, barberId } = await this.prisma.$transaction(async (tx) => {
        const created = await this.createShop(
          tx,
          userId,
          shopData,
          'INDEPENDENT',
          requireReview,
          ip,
        );
        const profile = await this.barbers.createIndependentProfile(tx, {
          barbershopId: created.id,
          userId,
          displayName: displayName ?? credentials?.fullName ?? dto.name,
          bio: bio ?? null,
          ip,
        });
        return { shop: created, barberId: profile.barberId };
      });
      return {
        ...this.manage(shop, 'OWNER'),
        ownerRoleGranted: !roles.includes('OWNER'),
        barberId,
        barberRoleGranted: !roles.includes('BARBER'),
      };
    } catch (error) {
      // Carrera con otra vinculación de la misma cuenta: índice único de barberos activos.
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

  private async createShop(
    tx: Prisma.TransactionClient,
    userId: string,
    dto: CreateBarbershopDto,
    type: 'BARBERSHOP' | 'INDEPENDENT',
    requireReview: boolean,
    ip: string | null,
  ): Promise<Barbershop> {
    const document = dto.ownerDocument ?? null;
    if (document && !isValidOwnerDocument(document.type, document.number)) throw invalidDocument();
    const requirePhoto = await this.settings.boolean(SettingKey.BARBERSHOPS_REQUIRE_PHOTO, false);
    const missing = missingRequirements({
      hasOwnerDocument: document !== null,
      hasPhoto: false, // las fotos llegan con la Fase 14
      requirePhoto,
    });
    // Sin revisión previa: visible al instante. Con revisión: a revisión si cumple los requisitos,
    // si no, borrador.
    const status = !requireReview ? 'OPEN' : missing.length === 0 ? 'PENDING_REVIEW' : 'DRAFT';
    const now = new Date();
    const created = await tx.barbershop.create({
      data: {
        name: dto.name,
        description: dto.description ?? null,
        address: dto.address,
        latitude: dto.latitude,
        longitude: dto.longitude,
        timezone: dto.timezone ?? DEFAULT_TIMEZONE,
        phone: dto.phone,
        websiteUrl: dto.websiteUrl ?? null,
        instagramUrl: dto.instagramUrl ?? null,
        facebookUrl: dto.facebookUrl ?? null,
        type,
        status,
        ...(document ? this.documentData(document) : {}),
        submittedForReviewAt: status === 'PENDING_REVIEW' ? now : null,
        members: { create: { userId, role: 'OWNER' } },
      },
    });
    if (status === 'PENDING_REVIEW') {
      await tx.barbershopReviewSubmission.create({
        data: { barbershopId: created.id, submittedById: userId, submittedAt: now },
      });
    }
    await this.users.addRole(userId, 'OWNER', tx);
    await this.audit.record(
      {
        actorId: userId,
        action: 'barbershop.created',
        entityType: 'barbershop',
        entityId: created.id,
        changes: {
          values: { type: { from: null, to: type }, status: { from: null, to: created.status } },
        },
        ip,
      },
      tx,
    );
    return created;
  }

  /** RF-BAR-002: consulta pública (solo barberías visibles). */
  async findPublic(id: string, viewerId: string | null = null): Promise<BarbershopPublicDto> {
    const shop = await this.prisma.barbershop.findFirst({ where: publicBarbershopWhere(id) });
    if (!shop) throw notFound();
    const favorites = await this.favorites.favoriteIds(viewerId, [shop.id]);
    return { ...toPublicDto(shop), isFavorite: favorites.has(shop.id) };
  }

  async findManaged(userId: string, id: string): Promise<BarbershopManageDto> {
    const membership = await this.access.requireMember(userId, id);
    const shop = await this.prisma.barbershop.findUniqueOrThrow({ where: { id } });
    return this.manage(shop, membership.role);
  }

  async listMine(userId: string, query: PaginationQueryDto): Promise<Page<MyBarbershopDto>> {
    const args = pageArgs(query);
    const rows = await this.prisma.barbershopMember.findMany({
      where: { userId, barbershop: { deletedAt: null }, ...args.where },
      orderBy: args.orderBy,
      take: args.take,
      include: { barbershop: { select: { id: true, name: true, type: true, status: true } } },
    });
    return toPage(rows, query, (m) => ({
      id: m.barbershop.id,
      name: m.barbershop.name,
      type: m.barbershop.type,
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
    return this.manage(updated, membership.role);
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
    return this.manage(updated, membership.role);
  }

  /** Borrado lógico (solo OWNER), rechazado si hay reservas futuras activas. */
  // ───────────── Alta con revisión previa ─────────────

  /**
   * Registrar o cambiar el documento del responsable (solo OWNER). Si la barbería ya fue
   * aprobada, no se oculta: queda marcada para soporte como "documento modificado".
   */
  async setOwnerDocument(
    userId: string,
    id: string,
    dto: OwnerDocumentInputDto,
    ip: string | null,
  ): Promise<BarbershopManageDto> {
    await this.access.requireMember(userId, id, ['OWNER']);
    if (!isValidOwnerDocument(dto.type, dto.number)) throw invalidDocument();
    const updated = await this.prisma.$transaction(async (tx) => {
      const before = await tx.barbershop.findUniqueOrThrow({
        where: { id },
        select: { status: true, ownerDocumentHash: true, ownerDocumentType: true },
      });
      const data = this.documentData(dto);
      const changed =
        before.ownerDocumentType !== dto.type ||
        !before.ownerDocumentHash ||
        !Buffer.from(before.ownerDocumentHash).equals(data.ownerDocumentHash);
      const flag = changed && wasApproved(before.status);
      const shop = await tx.barbershop.update({
        where: { id },
        data: {
          ...data,
          ...(flag ? { flaggedReason: OWNER_DOCUMENT_CHANGED_FLAG, flaggedAt: new Date() } : {}),
        },
      });
      if (changed) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'barbershop.owner_document_set',
            entityType: 'barbershop',
            entityId: id,
            // Sin el número: solo el tipo y si queda marcada para soporte.
            changes: { type: dto.type, personalFields: ['ownerDocument'], flagged: flag },
            ip,
          },
          tx,
        );
      }
      return shop;
    });
    return this.manage(updated, 'OWNER');
  }

  /** Estado de la revisión, lo que falta y el historial (OWNER o MANAGER). */
  async review(userId: string, id: string): Promise<BarbershopReviewDto> {
    await this.access.requireMember(userId, id);
    const shop = await this.prisma.barbershop.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        ownerDocumentType: true,
        reviewNotes: true,
        submittedForReviewAt: true,
        reviewSubmissions: {
          orderBy: { submittedAt: 'desc' },
          select: { submittedAt: true, decision: true, decidedAt: true, reason: true },
        },
      },
    });
    const missing = await this.missingFor(shop.ownerDocumentType !== null);
    return {
      status: shop.status,
      missingRequirements: missing,
      canSubmit: SUBMITTABLE_STATUSES.includes(shop.status) && missing.length === 0,
      reviewNotes: shop.reviewNotes,
      submittedAt: shop.submittedForReviewAt,
      submissions: shop.reviewSubmissions,
    };
  }

  /** Enviar (o reenviar) a revisión: DRAFT o CHANGES_REQUESTED → PENDING_REVIEW (solo OWNER). */
  async submitReview(userId: string, id: string, ip: string | null): Promise<BarbershopReviewDto> {
    await this.access.requireMember(userId, id, ['OWNER']);
    await this.prisma.$transaction(async (tx) => {
      const [shop] = await tx.$queryRaw<{ status: BarbershopStatus; has_document: boolean }[]>`
        SELECT status, owner_document_hash IS NOT NULL AS has_document
          FROM barbershops WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE`;
      if (!shop) throw notFound();
      if (!SUBMITTABLE_STATUSES.includes(shop.status)) {
        throw new AppException(
          ErrorCode.STATUS_CHANGE_NOT_ALLOWED,
          shop.status === 'PENDING_REVIEW'
            ? 'La barbería ya está en revisión.'
            : 'Solo se envía a revisión una barbería en borrador o con cambios pedidos.',
          HttpStatus.CONFLICT,
          [{ from: shop.status, to: 'PENDING_REVIEW' }],
        );
      }
      const missing = await this.missingFor(shop.has_document);
      if (missing.length > 0) {
        throw new AppException(
          ErrorCode.REVIEW_REQUIREMENTS_MISSING,
          'Completa lo que falta antes de enviar la barbería a revisión.',
          HttpStatus.CONFLICT,
          missing.map((requirement) => ({ requirement })),
        );
      }
      const now = new Date();
      await tx.barbershop.update({
        where: { id },
        data: { status: 'PENDING_REVIEW', submittedForReviewAt: now },
      });
      await tx.barbershopReviewSubmission.create({
        data: { barbershopId: id, submittedById: userId, submittedAt: now },
      });
      await this.audit.record(
        {
          actorId: userId,
          action: 'barbershop.review_submitted',
          entityType: 'barbershop',
          entityId: id,
          changes: { values: { status: { from: shop.status, to: 'PENDING_REVIEW' } } },
          ip,
        },
        tx,
      );
    });
    return this.review(userId, id);
  }

  private async missingFor(hasOwnerDocument: boolean): Promise<ReviewRequirement[]> {
    const requirePhoto = await this.settings.boolean(SettingKey.BARBERSHOPS_REQUIRE_PHOTO, false);
    return missingRequirements({ hasOwnerDocument, hasPhoto: false, requirePhoto });
  }

  private documentData(document: OwnerDocumentInputDto): {
    ownerDocumentType: OwnerDocumentInputDto['type'];
    ownerDocumentEnc: string;
    ownerDocumentHash: Buffer<ArrayBuffer>;
  } {
    return {
      ownerDocumentType: document.type,
      ownerDocumentEnc: this.encryption.encrypt(
        document.number,
        EncryptedField.BARBERSHOP_OWNER_DOCUMENT,
      ),
      ownerDocumentHash: this.encryption.blindIndex(document.number, BlindIndexKind.DOCUMENT),
    };
  }

  /** Vista de gestión: el documento solo para el OWNER, enmascarado. */
  private manage(shop: Barbershop, role: BarbershopMemberRole): BarbershopManageDto {
    const document =
      role === 'OWNER' && shop.ownerDocumentType && shop.ownerDocumentEnc
        ? {
            type: shop.ownerDocumentType,
            masked: maskDocument(
              this.encryption.decrypt(
                shop.ownerDocumentEnc,
                EncryptedField.BARBERSHOP_OWNER_DOCUMENT,
              ),
            ),
          }
        : null;
    return toManageDto(shop, role, document);
  }

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
      // Roles derivados: quien deja de administrar barberías pierde OWNER; quien deja de ser
      // barbero activo pierde BARBER.
      await this.barbers.removeAllOfBarbershop(id, tx);
      await this.members.syncOwnerRolesOf(id, tx);
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
