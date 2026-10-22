import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { BlindIndexKind, EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type {
  CampaignDto,
  CampaignMetricsDto,
  CreateCampaignDto,
  CreatePlacementDto,
  CreateProductDto,
  CreateSponsorDto,
  PlacementDto,
  ProductDto,
  PublicPlacementDto,
  PublicSponsorDto,
  SlotKey,
  SponsorDto,
  UpdateCampaignDto,
  UpdatePlacementDto,
  UpdateProductDto,
  UpdateSponsorDto,
} from './dto/sponsor.dto';

/** Anuncios por espacio y petición. */
const PLACEMENTS_PER_SLOT = 3;
const HOUR_MS = 3_600_000;
/** Espacios de la pantalla de la barbería; los demás son de clientes. */
const SHOP_SLOTS: ReadonlySet<SlotKey> = new Set(['shop_dashboard']);
/** Transiciones de estado de una campaña (ENDED es definitivo). */
const CAMPAIGN_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ACTIVE', 'ENDED'],
  ACTIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  ENDED: [],
};

const notFound = (what: string): AppException =>
  new AppException(ErrorCode.NOT_FOUND, `${what} no existe.`, HttpStatus.NOT_FOUND);

const invalid = (field: string, constraint: string): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );

/**
 * Auspiciadores (Fase 13): auspiciadores, campañas con público, espacios publicitarios, catálogo de
 * productos con enlace externo (Charles no vende ni cobra) e impresiones y clics sin guardar la IP.
 */
@Injectable()
export class SponsorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── App ─────────────

  /**
   * Anuncios vigentes de un espacio: campañas ACTIVE dentro de sus fechas, de auspiciadores
   * activos, para el público del espacio (clientes o barberías). Mayor prioridad primero.
   */
  async placementsFor(slot: SlotKey): Promise<PublicPlacementDto[]> {
    const now = new Date(this.clock.now());
    const audiences = SHOP_SLOTS.has(slot) ? ['BARBERSHOPS', 'ALL'] : ['CLIENTS', 'ALL'];
    const rows = await this.prisma.sponsorPlacement.findMany({
      where: {
        slotKey: slot,
        campaign: {
          status: 'ACTIVE',
          deletedAt: null,
          startsAt: { lte: now },
          endsAt: { gt: now },
          audience: { in: audiences as ('CLIENTS' | 'BARBERSHOPS' | 'ALL')[] },
          sponsor: { isActive: true, deletedAt: null },
        },
      },
      include: { campaign: { include: { sponsor: true } } },
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      take: PLACEMENTS_PER_SLOT,
    });
    return rows.map((p) => ({
      id: p.id,
      title: p.title,
      imageUrl: p.imageUrl,
      actionUrl: p.actionUrl,
      sponsorId: p.campaign.sponsorId,
      sponsorName: p.campaign.sponsor.name,
      sponsorLogoUrl: p.campaign.sponsor.logoUrl,
    }));
  }

  /**
   * Registra una impresión o un clic. Uno por persona (o instalación anónima) por hora y tipo:
   * los repetidos se ignoran. Sin IP ni identificadores en claro.
   */
  async recordEvent(
    placementId: string,
    type: 'IMPRESSION' | 'CLICK',
    viewer: { userId: string | null; viewerKey?: string },
  ): Promise<void> {
    const key = viewer.userId
      ? `user:${viewer.userId}`
      : viewer.viewerKey
        ? `anon:${viewer.viewerKey}`
        : null;
    if (!key) throw invalid('viewerKey', 'requiredWithoutSession');
    const exists = await this.prisma.sponsorPlacement.count({ where: { id: placementId } });
    if (!exists) throw notFound('El anuncio');
    const now = this.clock.now();
    const { count: inserted } = await this.prisma.sponsorEvent.createMany({
      data: [
        {
          placementId,
          userId: viewer.userId,
          type,
          viewerHash: this.encryption.blindIndex(key, BlindIndexKind.SPONSOR_VIEWER),
          hourBucket: new Date(Math.floor(now / HOUR_MS) * HOUR_MS),
        },
      ],
      skipDuplicates: true,
    });
    if (inserted > 0 && type === 'IMPRESSION') await this.countImpression(placementId);
  }

  /** Fase 15: suma la impresión a la campaña y la termina al llegar al tope del paquete. */
  private async countImpression(placementId: string): Promise<void> {
    const placement = await this.prisma.sponsorPlacement.findUnique({
      where: { id: placementId },
      select: { campaignId: true },
    });
    if (!placement) return;
    await this.prisma.$executeRaw`
      UPDATE sponsor_campaigns
         SET impressions_count = impressions_count + 1,
             status = CASE
               WHEN impressions_limit IS NOT NULL AND impressions_count + 1 >= impressions_limit
               THEN 'ENDED'::"SponsorCampaignStatus" ELSE status END,
             updated_at = now()
       WHERE id = ${placement.campaignId}::uuid`;
  }

  async publicSponsor(id: string): Promise<PublicSponsorDto> {
    const sponsor = await this.prisma.sponsor.findFirst({
      where: { id, isActive: true, deletedAt: null },
      include: {
        products: {
          where: { isActive: true, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!sponsor) throw notFound('El auspiciador');
    return {
      id: sponsor.id,
      name: sponsor.name,
      logoUrl: sponsor.logoUrl,
      products: sponsor.products.map(toProduct),
    };
  }

  // ───────────── ADMIN: auspiciadores ─────────────

  async listSponsors(): Promise<SponsorDto[]> {
    const rows = await this.prisma.sponsor.findMany({
      where: { deletedAt: null },
      include: {
        _count: {
          select: {
            campaigns: { where: { deletedAt: null } },
            products: { where: { deletedAt: null } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((s) => this.toSponsor(s, s._count.campaigns, s._count.products));
  }

  async createSponsor(actorId: string, dto: CreateSponsorDto): Promise<SponsorDto> {
    const sponsor = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sponsor.create({
        data: {
          name: dto.name,
          logoUrl: dto.logoUrl ?? null,
          contactEnc: this.encryption.encryptNullable(dto.contact, EncryptedField.SPONSOR_CONTACT),
        },
      });
      await this.record(tx, actorId, 'sponsor.created', 'sponsor', created.id);
      return created;
    });
    return this.toSponsor(sponsor, 0, 0);
  }

  async updateSponsor(actorId: string, id: string, dto: UpdateSponsorDto): Promise<SponsorDto> {
    await this.requireSponsor(id);
    const data: Prisma.SponsorUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.logoUrl !== undefined) data.logoUrl = dto.logoUrl;
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.contact !== undefined) {
      data.contactEnc = this.encryption.encryptNullable(
        dto.contact,
        EncryptedField.SPONSOR_CONTACT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.sponsor.update({ where: { id }, data });
      await this.record(tx, actorId, 'sponsor.updated', 'sponsor', id, {
        fields: Object.keys(dto),
      });
    });
    return (await this.listSponsors()).find((s) => s.id === id)!;
  }

  // ───────────── ADMIN: campañas y espacios ─────────────

  async listCampaigns(sponsorId: string): Promise<CampaignDto[]> {
    await this.requireSponsor(sponsorId);
    const rows = await this.prisma.sponsorCampaign.findMany({
      where: { sponsorId, deletedAt: null },
      include: { placements: { orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] } },
      orderBy: { startsAt: 'desc' },
    });
    return rows.map((c) => this.toCampaign(c));
  }

  async createCampaign(
    actorId: string,
    sponsorId: string,
    dto: CreateCampaignDto,
  ): Promise<CampaignDto> {
    await this.requireSponsor(sponsorId);
    if (dto.endsAt <= dto.startsAt) throw invalid('endsAt', 'afterStartsAt');
    const campaign = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sponsorCampaign.create({
        data: {
          sponsorId,
          name: dto.name,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
          audience: dto.audience ?? 'ALL',
        },
        include: { placements: true },
      });
      await this.record(tx, actorId, 'sponsor_campaign.created', 'sponsor_campaign', created.id);
      return created;
    });
    return this.toCampaign(campaign);
  }

  async updateCampaign(actorId: string, id: string, dto: UpdateCampaignDto): Promise<CampaignDto> {
    const current = await this.prisma.sponsorCampaign.findFirst({ where: { id, deletedAt: null } });
    if (!current) throw notFound('La campaña');
    if (dto.endsAt && dto.endsAt <= current.startsAt) throw invalid('endsAt', 'afterStartsAt');
    if (dto.status && dto.status !== current.status) {
      if (!CAMPAIGN_TRANSITIONS[current.status]!.includes(dto.status)) {
        throw new AppException(
          ErrorCode.INVALID_STATE_TRANSITION,
          'La campaña no admite ese cambio de estado.',
          HttpStatus.CONFLICT,
          [{ from: current.status, to: dto.status }],
        );
      }
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.sponsorCampaign.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.endsAt !== undefined ? { endsAt: dto.endsAt } : {}),
          ...(dto.audience !== undefined ? { audience: dto.audience } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
        include: { placements: { orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] } },
      });
      await this.record(tx, actorId, 'sponsor_campaign.updated', 'sponsor_campaign', id, {
        fields: Object.keys(dto),
        ...(dto.status ? { status: dto.status } : {}),
      });
      return row;
    });
    return this.toCampaign(updated);
  }

  async addPlacement(
    actorId: string,
    campaignId: string,
    dto: CreatePlacementDto,
  ): Promise<CampaignDto> {
    await this.requireCampaign(campaignId);
    await this.prisma.$transaction(async (tx) => {
      // Fase 15: una campaña de un paquete admite hasta `placementsLimit` anuncios.
      const purchase = await tx.sponsorPackagePurchase.findUnique({
        where: { campaignId },
        select: { package: { select: { placementsLimit: true } } },
      });
      if (purchase) {
        const [lock] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text FROM sponsor_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
        const count = await tx.sponsorPlacement.count({ where: { campaignId } });
        if (lock && count >= purchase.package.placementsLimit) {
          throw new AppException(
            ErrorCode.PLAN_LIMIT_REACHED,
            'El paquete de esta campaña no admite más anuncios.',
            HttpStatus.FORBIDDEN,
            [{ key: 'placements', limit: purchase.package.placementsLimit, used: count }],
          );
        }
      }
      const created = await tx.sponsorPlacement.create({
        data: {
          campaignId,
          slotKey: dto.slotKey,
          title: dto.title,
          imageUrl: dto.imageUrl ?? null,
          actionUrl: dto.actionUrl ?? null,
          priority: dto.priority ?? 0,
        },
      });
      await this.record(tx, actorId, 'sponsor_placement.created', 'sponsor_placement', created.id);
    });
    return this.campaign(campaignId);
  }

  async updatePlacement(
    actorId: string,
    placementId: string,
    dto: UpdatePlacementDto,
  ): Promise<CampaignDto> {
    const placement = await this.prisma.sponsorPlacement.findUnique({ where: { id: placementId } });
    if (!placement) throw notFound('El anuncio');
    await this.prisma.$transaction(async (tx) => {
      await tx.sponsorPlacement.update({
        where: { id: placementId },
        data: {
          ...(dto.title !== undefined ? { title: dto.title } : {}),
          ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl } : {}),
          ...(dto.actionUrl !== undefined ? { actionUrl: dto.actionUrl } : {}),
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        },
      });
      await this.record(tx, actorId, 'sponsor_placement.updated', 'sponsor_placement', placementId);
    });
    return this.campaign(placement.campaignId);
  }

  /** Quita un anuncio; si ya tiene impresiones o clics, no se borra: se pausa la campaña. */
  async removePlacement(actorId: string, placementId: string): Promise<CampaignDto> {
    const placement = await this.prisma.sponsorPlacement.findUnique({
      where: { id: placementId },
      include: { _count: { select: { events: true } } },
    });
    if (!placement) throw notFound('El anuncio');
    if (placement._count.events > 0) {
      throw new AppException(
        ErrorCode.CONFLICT,
        'El anuncio ya tiene impresiones o clics: pausa o termina la campaña en lugar de borrarlo.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.sponsorPlacement.delete({ where: { id: placementId } });
      await this.record(tx, actorId, 'sponsor_placement.removed', 'sponsor_placement', placementId);
    });
    return this.campaign(placement.campaignId);
  }

  async metrics(campaignId: string): Promise<CampaignMetricsDto> {
    const campaign = await this.prisma.sponsorCampaign.findFirst({
      where: { id: campaignId, deletedAt: null },
      include: { placements: true },
    });
    if (!campaign) throw notFound('La campaña');
    const counts = await this.prisma.sponsorEvent.groupBy({
      by: ['placementId', 'type'],
      where: { placementId: { in: campaign.placements.map((p) => p.id) } },
      _count: { _all: true },
    });
    const count = (placementId: string, type: 'IMPRESSION' | 'CLICK') =>
      counts.find((c) => c.placementId === placementId && c.type === type)?._count._all ?? 0;
    const placements = campaign.placements.map((p) => {
      const impressions = count(p.id, 'IMPRESSION');
      const clicks = count(p.id, 'CLICK');
      return {
        placementId: p.id,
        slotKey: p.slotKey,
        title: p.title,
        impressions,
        clicks,
        ctr: ratio(clicks, impressions),
      };
    });
    const impressions = placements.reduce((sum, p) => sum + p.impressions, 0);
    const clicks = placements.reduce((sum, p) => sum + p.clicks, 0);
    return { campaignId, impressions, clicks, ctr: ratio(clicks, impressions), placements };
  }

  // ───────────── ADMIN: productos ─────────────

  async listProducts(sponsorId: string): Promise<ProductDto[]> {
    await this.requireSponsor(sponsorId);
    const rows = await this.prisma.sponsorProduct.findMany({
      where: { sponsorId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toProduct);
  }

  async createProduct(
    actorId: string,
    sponsorId: string,
    dto: CreateProductDto,
  ): Promise<ProductDto> {
    await this.requireSponsor(sponsorId);
    const product = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sponsorProduct.create({
        data: {
          sponsorId,
          name: dto.name,
          description: dto.description ?? null,
          imageUrl: dto.imageUrl ?? null,
          actionUrl: dto.actionUrl,
          priceText: dto.priceText ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
      await this.record(tx, actorId, 'sponsor_product.created', 'sponsor_product', created.id);
      return created;
    });
    return toProduct(product);
  }

  async updateProduct(
    actorId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<ProductDto> {
    const current = await this.prisma.sponsorProduct.findFirst({
      where: { id: productId, deletedAt: null },
    });
    if (!current) throw notFound('El producto');
    const product = await this.prisma.$transaction(async (tx) => {
      const row = await tx.sponsorProduct.update({
        where: { id: productId },
        data: Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)),
      });
      await this.record(tx, actorId, 'sponsor_product.updated', 'sponsor_product', productId, {
        fields: Object.keys(dto),
      });
      return row;
    });
    return toProduct(product);
  }

  // ───────────── Común ─────────────

  private async campaign(id: string): Promise<CampaignDto> {
    const row = await this.prisma.sponsorCampaign.findUniqueOrThrow({
      where: { id },
      include: { placements: { orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] } },
    });
    return this.toCampaign(row);
  }

  private async requireSponsor(id: string): Promise<void> {
    const found = await this.prisma.sponsor.count({ where: { id, deletedAt: null } });
    if (!found) throw notFound('El auspiciador');
  }

  private async requireCampaign(id: string): Promise<void> {
    const found = await this.prisma.sponsorCampaign.count({ where: { id, deletedAt: null } });
    if (!found) throw notFound('La campaña');
  }

  private record(
    tx: Prisma.TransactionClient,
    actorId: string,
    action: string,
    entityType: string,
    entityId: string,
    changes?: Prisma.InputJsonValue,
  ): Promise<void> {
    return this.audit.record({ actorId, action, entityType, entityId, changes }, tx);
  }

  private toSponsor(
    s: {
      id: string;
      name: string;
      logoUrl: string | null;
      contactEnc: string | null;
      isActive: boolean;
      createdAt: Date;
    },
    campaigns: number,
    products: number,
  ): SponsorDto {
    return {
      id: s.id,
      name: s.name,
      logoUrl: s.logoUrl,
      contact: this.encryption.decryptNullable(s.contactEnc, EncryptedField.SPONSOR_CONTACT),
      isActive: s.isActive,
      campaigns,
      products,
      createdAt: s.createdAt,
    };
  }

  private toCampaign(c: {
    id: string;
    sponsorId: string;
    name: string;
    startsAt: Date;
    endsAt: Date;
    audience: 'CLIENTS' | 'BARBERSHOPS' | 'ALL';
    status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';
    createdAt: Date;
    impressionsLimit?: number | null;
    impressionsCount?: number;
    placements: {
      id: string;
      slotKey: string;
      title: string;
      imageUrl: string | null;
      actionUrl: string | null;
      priority: number;
    }[];
  }): CampaignDto {
    const now = this.clock.now();
    return {
      id: c.id,
      sponsorId: c.sponsorId,
      name: c.name,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      audience: c.audience,
      status: c.status,
      live: c.status === 'ACTIVE' && c.startsAt.getTime() <= now && c.endsAt.getTime() > now,
      impressionsLimit: c.impressionsLimit ?? null,
      impressionsCount: c.impressionsCount ?? 0,
      placements: c.placements.map((p): PlacementDto => ({
        id: p.id,
        slotKey: p.slotKey,
        title: p.title,
        imageUrl: p.imageUrl,
        actionUrl: p.actionUrl,
        priority: p.priority,
      })),
      createdAt: c.createdAt,
    };
  }
}

function toProduct(p: {
  id: string;
  sponsorId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  actionUrl: string;
  priceText: string | null;
  sortOrder: number;
  isActive: boolean;
}): ProductDto {
  return {
    id: p.id,
    sponsorId: p.sponsorId,
    name: p.name,
    description: p.description,
    imageUrl: p.imageUrl,
    actionUrl: p.actionUrl,
    priceText: p.priceText,
    sortOrder: p.sortOrder,
    isActive: p.isActive,
  };
}

function ratio(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 10_000) / 10_000;
}
