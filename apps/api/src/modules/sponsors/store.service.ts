import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { BlindIndexKind } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { PUBLIC_STATUSES } from '../barbershops/barbershop-access.service';
import { parseRules } from '../promotions/discount-policy';
import { VideosService } from '../videos/videos.service';
import type {
  StoreBrandDto,
  StoreDealDto,
  StoreDto,
  StoreProductDto,
  StoreQueryDto,
} from './dto/sponsor.dto';
import { offerActive, SponsorsService, toPublicProduct } from './sponsors.service';

const HOUR_MS = 3_600_000;
/** Productos que se leen por petición (la Tienda muestra un resumen, no el catálogo entero). */
const PRODUCTS_SCAN = 200;
const LIMITS = { offers: 20, products: 30, brands: 30, videos: 10, deals: 20 } as const;

/**
 * Tienda: escaparate de las marcas auspiciadoras (ofertas, productos, marcas por rubro y videos)
 * y de los descuentos en reservas. Todo es publicidad etiquetada: nunca se mezcla con la
 * Comunidad. Charles no vende ni cobra los productos: cada uno enlaza a la tienda de la marca.
 */
@Injectable()
export class StoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sponsors: SponsorsService,
    private readonly videos: VideosService,
    private readonly encryption: EncryptionService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async store(query: StoreQueryDto): Promise<StoreDto> {
    const audience = query.audience ?? 'CLIENTS';
    const now = this.clock.now();
    const productWhere: Prisma.SponsorProductWhereInput = {
      isActive: true,
      deletedAt: null,
      audience: { in: [audience, 'ALL'] },
    };
    const activeSponsor: Prisma.SponsorWhereInput = { isActive: true, deletedAt: null };
    const sponsorWhere: Prisma.SponsorWhereInput = {
      ...activeSponsor,
      ...(query.category ? { category: query.category } : {}),
    };

    const [rows, brandRows, categoryRows, featured, videos, deals] = await Promise.all([
      this.prisma.sponsorProduct.findMany({
        where: { ...productWhere, sponsor: { is: sponsorWhere } },
        include: { sponsor: { select: { name: true, logoUrl: true, category: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: PRODUCTS_SCAN,
      }),
      this.prisma.sponsor.findMany({
        where: { ...sponsorWhere, products: { some: productWhere } },
        include: {
          products: {
            where: productWhere,
            select: {
              priceAmount: true,
              offerPriceAmount: true,
              offerEndsAt: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
        take: LIMITS.brands,
      }),
      this.prisma.sponsor.groupBy({
        by: ['category'],
        where: { ...activeSponsor, products: { some: productWhere } },
        _count: { _all: true },
      }),
      this.sponsors.placementsFor('store_featured', audience),
      // Solo videos de marcas con productos para este público (máquinas no van a clientes).
      this.videos.latestSponsorVideos(LIMITS.videos, {
        ...sponsorWhere,
        products: { some: productWhere },
      }),
      audience === 'CLIENTS' ? this.deals(now) : Promise.resolve([]),
    ]);

    const items: StoreProductDto[] = rows.map((r) => ({
      ...toPublicProduct(r, now),
      sponsorName: r.sponsor.name,
      sponsorLogoUrl: r.sponsor.logoUrl,
      category: r.sponsor.category,
    }));
    const offers = items
      .filter((p) => p.discountPercent !== null)
      .sort((a, b) => b.discountPercent! - a.discountPercent!)
      .slice(0, LIMITS.offers);
    const products = items.filter((p) => p.discountPercent === null).slice(0, LIMITS.products);

    const brands: StoreBrandDto[] = brandRows.map((b) => ({
      id: b.id,
      name: b.name,
      logoUrl: b.logoUrl,
      coverUrl: b.coverUrl,
      category: b.category,
      description: b.description,
      productCount: b.products.length,
      hasOffers: b.products.some((p) => offerActive(p, now)),
    }));

    const sponsorInfo = new Map(
      (
        await this.prisma.sponsor.findMany({
          where: { id: { in: [...new Set(videos.map((v) => v.sponsorId))] } },
          select: { id: true, name: true, logoUrl: true },
        })
      ).map((s) => [s.id, s]),
    );

    return {
      featured,
      offers,
      products,
      brands,
      categories: categoryRows
        .map((c) => ({ category: c.category, brands: c._count._all }))
        .sort((a, b) => b.brands - a.brands),
      videos: videos
        .filter((v) => sponsorInfo.has(v.sponsorId))
        .map((v) => ({
          ...v,
          sponsorName: sponsorInfo.get(v.sponsorId)!.name,
          sponsorLogoUrl: sponsorInfo.get(v.sponsorId)!.logoUrl,
        })),
      deals,
    };
  }

  /**
   * Clic a "Ver en la tienda": uno por persona (o instalación anónima) por hora; los repetidos se
   * ignoran. Sin IP ni identificadores en claro.
   */
  async productClick(
    productId: string,
    viewer: { userId: string | null; viewerKey?: string },
  ): Promise<void> {
    const key = viewer.userId
      ? `user:${viewer.userId}`
      : viewer.viewerKey
        ? `anon:${viewer.viewerKey}`
        : null;
    if (!key) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'Los datos enviados no son válidos.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'viewerKey', constraints: ['requiredWithoutSession'] }],
      );
    }
    const exists = await this.prisma.sponsorProduct.count({
      where: { id: productId, isActive: true, deletedAt: null },
    });
    if (!exists) {
      throw new AppException(ErrorCode.NOT_FOUND, 'El producto no existe.', HttpStatus.NOT_FOUND);
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.sponsorProductClick.createMany({
        data: [
          {
            productId,
            viewerHash: this.encryption.blindIndex(`product:${key}`, BlindIndexKind.SPONSOR_VIEWER),
            hourBucket: new Date(Math.floor(now / HOUR_MS) * HOUR_MS),
          },
        ],
        skipDuplicates: true,
      });
      if (count > 0) {
        await tx.sponsorProduct.update({
          where: { id: productId },
          data: { clickCount: { increment: 1 } },
        });
      }
    });
  }

  /**
   * Descuentos automáticos vigentes para cualquier cliente (de Charles y de barberías visibles),
   * con cupos libres.
   */
  private async deals(now: number): Promise<StoreDealDto[]> {
    const at = new Date(now);
    const rows = await this.prisma.promotion.findMany({
      where: {
        deletedAt: null,
        isActive: true,
        requiresCoupon: false,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
        AND: [
          {
            OR: [
              { scope: 'PLATFORM' },
              { barbershop: { deletedAt: null, status: { in: PUBLIC_STATUSES } } },
            ],
          },
        ],
      },
      include: { barbershop: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take: LIMITS.deals * 2,
    });
    const used = new Map(
      (
        await this.prisma.promotionRedemption.groupBy({
          by: ['promotionId'],
          where: { promotionId: { in: rows.map((r) => r.id) }, releasedAt: null },
          _count: { _all: true },
        })
      ).map((u) => [u.promotionId, u._count._all]),
    );
    return (
      rows
        .filter((r) => r.maxRedemptions === null || (used.get(r.id) ?? 0) < r.maxRedemptions)
        // Los de nivel mínimo (clientes frecuentes) no valen para cualquiera: no se anuncian.
        .filter((r) => !parseRules(r.rules).minTier)
        .slice(0, LIMITS.deals)
        .map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          value: r.value,
          currency: r.currency,
          daysOfWeek: parseRules(r.rules).daysOfWeek ?? [],
          endsAt: r.endsAt,
          fromCharles: r.scope === 'PLATFORM',
          barbershopId: r.barbershop?.id ?? null,
          barbershopName: r.barbershop?.name ?? null,
        }))
    );
  }
}
