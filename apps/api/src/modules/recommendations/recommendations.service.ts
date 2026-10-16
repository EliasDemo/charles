import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { IMAGE_DEFAULTS, isHiddenByReports } from '../images/image-policy';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { type StoredVariants, variantUrl } from '../images/image-variants';
import { SettingKey, SettingsService } from '../settings/settings.service';
import type {
  FaceShapeResultDto,
  HaircutRecommendationDto,
  RankedStyleBarberDto,
  RecommendedHaircutDto,
  RecommendedPhotoDto,
  RecommendHaircutsDto,
} from './dto/recommendation.dto';
import {
  classifyFaceShape,
  type FaceMeasurements,
  type FaceShape,
  validMeasurements,
} from './face-shape';
import {
  barberStyleScore,
  barberSummary,
  type BarberStyleStats,
  compatibility,
  DEFAULT_WEIGHTS,
  type RankingWeights,
} from './recommendation-policy';

const HAIRCUTS = 5;
const PHOTOS_PER_HAIRCUT = 6;
const BARBERS_PER_HAIRCUT = 3;
const DAY_MS = 86_400_000;
const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 50;
export const RECOMMENDATION_DISCLAIMER =
  'La forma de cara es una aproximación y muchas caras son mixtas: tómalo como una sugerencia, ' +
  'no como una regla. Tu barbero te puede orientar mejor.';

const invalid = (field: string, constraint: string): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );

interface NearbyShop {
  id: string;
  name: string;
  distance: number;
}

/**
 * Recomendación por forma de cara (Etapa 1): qué cortes favorecen la forma del cliente (reglas
 * forma ↔ corte ajustadas a sus preferencias), fotos reales cerca de caras parecidas y los barberos
 * que mejor dominan cada corte (pesos configurables por ADMIN). Nada del cliente se guarda: la forma
 * o las medidas y la ubicación solo existen durante la petición.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  classify(m: FaceMeasurements): FaceShapeResultDto {
    if (!validMeasurements(m)) throw invalid('measurements', 'plausibleFace');
    return classifyFaceShape(m);
  }

  async recommend(
    dto: RecommendHaircutsDto,
    savedShape: FaceShape | null,
  ): Promise<HaircutRecommendationDto> {
    const faceShape: FaceShapeResultDto = dto.measurements
      ? this.classify(dto.measurements)
      : dto.faceShape
        ? { shape: dto.faceShape, confidence: 1, alternatives: [] }
        : savedShape
          ? { shape: savedShape, confidence: 1, alternatives: [] }
          : (() => {
              throw invalid('faceShape', 'faceShapeOrMeasurements');
            })();
    const shape = faceShape.shape;

    const radiusKm = Math.min(
      dto.radiusKm ??
        (await this.settings.positiveInt(SettingKey.SEARCH_DEFAULT_RADIUS_KM, DEFAULT_RADIUS_KM)),
      MAX_RADIUS_KM,
    );
    const radiusMeters = radiusKm * 1000;
    const shops = await this.nearbyShops(dto.lat, dto.lng, radiusMeters);

    // 1. Cortes compatibles (solo cortes de cabello con regla para esa forma).
    const rules = await this.prisma.faceShapeRule.findMany({
      where: { faceShape: shape, style: { isActive: true, category: { key: 'haircut' } } },
      include: { style: true },
    });
    const ranked = rules
      .map((rule) => ({
        rule,
        compatibility: compatibility(
          rule.score,
          {
            hairTypes: rule.style.hairTypes,
            vibe: rule.style.vibe,
            maintenance: rule.style.maintenance,
          },
          { hairType: dto.hairType, vibe: dto.vibe, maintenance: dto.maintenance },
        ),
      }))
      .filter((r): r is typeof r & { compatibility: number } => r.compatibility !== null)
      .sort(
        (a, b) =>
          b.compatibility - a.compatibility || a.rule.style.sortOrder - b.rule.style.sortOrder,
      )
      .slice(0, HAIRCUTS);
    const styleIds = ranked.map((r) => r.rule.styleId);

    // 2. Fotos y barberos de esos cortes, en las barberías cercanas.
    const [photos, barbers] = await Promise.all([
      this.photosFor(styleIds, shape, shops),
      this.barbersFor(styleIds, shape, shops, radiusMeters),
    ]);

    const haircuts: RecommendedHaircutDto[] = ranked.map(({ rule, compatibility: score }) => ({
      style: { id: rule.style.id, key: rule.style.key, name: rule.style.name },
      description: rule.style.description,
      maintenance: rule.style.maintenance,
      compatibility: score,
      reason: rule.note,
      ruleValidated: rule.validated,
      photos: photos.get(rule.styleId) ?? [],
      barbers: barbers.get(rule.styleId) ?? [],
    }));
    return { faceShape, haircuts, disclaimer: RECOMMENDATION_DISCLAIMER };
  }

  // ───────────── Internos ─────────────

  private async nearbyShops(lat: number, lng: number, radiusMeters: number): Promise<NearbyShop[]> {
    const point = Prisma.sql`ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography`;
    return this.prisma.$queryRaw<NearbyShop[]>`
      SELECT b.id::text AS id, b.name, ROUND(ST_Distance(b.location, ${point}))::int AS distance
        FROM barbershops b
       WHERE b.deleted_at IS NULL AND b.status IN ('OPEN', 'TEMPORARILY_CLOSED')
         AND ST_DWithin(b.location, ${point}, ${radiusMeters}::float8)
       ORDER BY distance
       LIMIT 300`;
  }

  /** Fotos reales cerca: primero caras de la misma forma, luego confirmadas, luego recientes. */
  private async photosFor(
    styleIds: string[],
    shape: FaceShape,
    shops: NearbyShop[],
  ): Promise<Map<string, RecommendedPhotoDto[]>> {
    const result = new Map<string, RecommendedPhotoDto[]>();
    if (styleIds.length === 0 || shops.length === 0) return result;
    const threshold = await this.settings.positiveInt(
      SettingKey.IMAGES_REPORT_HIDE_THRESHOLD,
      IMAGE_DEFAULTS.reportHideThreshold,
    );
    const shopById = new Map(shops.map((s) => [s.id, s]));
    const rows = await this.prisma.image.findMany({
      where: {
        kind: 'GALLERY',
        deletedAt: null,
        removedAt: null,
        consentGiven: true,
        barbershopId: { in: [...shopById.keys()] },
        styles: { some: { styleId: { in: styleIds } } },
      },
      include: {
        styles: { select: { styleId: true } },
        barberProfile: { select: { id: true, displayName: true, deletedAt: true } },
        _count: { select: { reports: { where: { status: { not: 'RESOLVED' } } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 400,
    });
    const visible = rows.filter((r) => !isHiddenByReports(r._count.reports, threshold));
    for (const styleId of styleIds) {
      const list = visible
        .filter((r) => r.styles.some((s) => s.styleId === styleId))
        .sort(
          (a, b) =>
            Number(b.faceShape === shape) - Number(a.faceShape === shape) ||
            Number(b.labelConfirmed) - Number(a.labelConfirmed) ||
            Number(a.isDemo) - Number(b.isDemo) ||
            b.createdAt.getTime() - a.createdAt.getTime(),
        )
        .slice(0, PHOTOS_PER_HAIRCUT)
        .map((r): RecommendedPhotoDto => {
          const v = r.variants as StoredVariants;
          const shop = shopById.get(r.barbershopId!)!;
          const profile = r.barberProfile && !r.barberProfile.deletedAt ? r.barberProfile : null;
          return {
            id: r.id,
            thumbUrl: variantUrl(this.storage, v, 'thumb')!,
            largeUrl: variantUrl(this.storage, v, 'large')!,
            faceShape: r.faceShape,
            sameFaceShape: r.faceShape === shape,
            confirmed: r.labelConfirmed,
            isDemo: r.isDemo,
            barbershopId: shop.id,
            barbershopName: shop.name,
            barberProfileId: profile?.id ?? null,
            barberName: profile?.displayName ?? null,
            serviceId: r.serviceId,
            distanceMeters: shop.distance,
          };
        });
      result.set(styleId, list);
    }
    return result;
  }

  /** Mejores barberos de cada corte entre los que trabajan hoy en barberías cercanas. */
  private async barbersFor(
    styleIds: string[],
    shape: FaceShape,
    shops: NearbyShop[],
    radiusMeters: number,
  ): Promise<Map<string, RankedStyleBarberDto[]>> {
    const result = new Map<string, RankedStyleBarberDto[]>();
    if (styleIds.length === 0 || shops.length === 0) return result;
    const shopById = new Map(shops.map((s) => [s.id, s]));
    const links = await this.prisma.barber.findMany({
      where: {
        barbershopId: { in: [...shopById.keys()] },
        isActive: true,
        deletedAt: null,
        endedAt: null,
        barberProfile: { deletedAt: null },
      },
      select: {
        id: true,
        barbershopId: true,
        barberProfile: { select: { id: true, displayName: true, photoVariants: true } },
      },
    });
    // El vínculo más cercano de cada barbero (puede trabajar en varias barberías).
    const nearest = new Map<string, (typeof links)[number]>();
    for (const link of links) {
      const profileId = link.barberProfile!.id;
      const current = nearest.get(profileId);
      if (
        !current ||
        shopById.get(link.barbershopId)!.distance < shopById.get(current.barbershopId)!.distance
      ) {
        nearest.set(profileId, link);
      }
    }
    const profileIds = [...nearest.keys()];
    if (profileIds.length === 0) return result;

    const [works, ratings, weights] = await Promise.all([
      this.prisma.$queryRaw<
        { profile_id: string; style_id: string; works: number; same: number; last: Date }[]
      >`
        SELECT i.barber_profile_id::text AS profile_id, s.style_id::text AS style_id,
               COUNT(*)::int AS works,
               COUNT(*) FILTER (WHERE i.face_shape = ${shape}::"FaceShape")::int AS same,
               MAX(i.created_at) AS last
          FROM images i JOIN image_styles s ON s.image_id = i.id
         WHERE i.kind = 'GALLERY' AND i.deleted_at IS NULL AND i.removed_at IS NULL
           AND i.label_confirmed AND NOT i.is_demo
           AND i.barber_profile_id = ANY(${profileIds}::uuid[])
           AND s.style_id = ANY(${styleIds}::uuid[])
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<
        { profile_id: string; style_id: string; average: string; count: number }[]
      >`
        SELECT b.barber_profile_id::text AS profile_id, b.style_id::text AS style_id,
               AVG(r.rating)::text AS average, COUNT(*)::int AS count
          FROM reviews r JOIN bookings b ON b.id = r.booking_id
         WHERE r.deleted_at IS NULL AND r.status <> 'HIDDEN'
           AND b.barber_profile_id = ANY(${profileIds}::uuid[])
           AND b.style_id = ANY(${styleIds}::uuid[])
         GROUP BY 1, 2`,
      this.weights(),
    ]);
    const worksBy = new Map(works.map((w) => [`${w.profile_id}:${w.style_id}`, w]));
    const ratingBy = new Map(ratings.map((r) => [`${r.profile_id}:${r.style_id}`, r]));
    const now = this.clock.now();

    for (const styleId of styleIds) {
      const list = profileIds
        .flatMap((profileId) => {
          const w = worksBy.get(`${profileId}:${styleId}`);
          const r = ratingBy.get(`${profileId}:${styleId}`);
          if (!w && !r) return []; // Sin trabajos ni valoraciones de ese corte: no se recomienda.
          const link = nearest.get(profileId)!;
          const shop = shopById.get(link.barbershopId)!;
          const stats: BarberStyleStats = {
            confirmedWorks: w?.works ?? 0,
            sameShapeWorks: w?.same ?? 0,
            ratingAverage: r ? Math.round(Number(r.average) * 100) / 100 : null,
            ratingCount: r?.count ?? 0,
            daysSinceLastWork: w ? Math.max(0, (now - w.last.getTime()) / DAY_MS) : null,
            distanceMeters: shop.distance,
            radiusMeters,
          };
          return [
            {
              barberProfileId: profileId,
              displayName: link.barberProfile!.displayName,
              photoUrl: variantUrl(this.storage, link.barberProfile!.photoVariants, 'square'),
              barbershopId: shop.id,
              barbershopName: shop.name,
              barberId: link.id,
              distanceMeters: shop.distance,
              confirmedWorks: stats.confirmedWorks,
              sameShapeWorks: stats.sameShapeWorks,
              styleRatingAverage: stats.ratingAverage,
              styleRatingCount: stats.ratingCount,
              score: barberStyleScore(stats, weights),
              summary: barberSummary(stats, shape),
            },
          ];
        })
        .sort((a, b) => b.score - a.score || a.distanceMeters - b.distanceMeters)
        .slice(0, BARBERS_PER_HAIRCUT);
      result.set(styleId, list);
    }
    return result;
  }

  private async weights(): Promise<RankingWeights> {
    const read = (key: string, fallback: number) => this.settings.nonNegativeInt(key, fallback);
    const [works, sameShape, rating, recency, distance] = await Promise.all([
      read(SettingKey.RECOMMEND_WEIGHT_WORKS, DEFAULT_WEIGHTS.works),
      read(SettingKey.RECOMMEND_WEIGHT_SAME_SHAPE, DEFAULT_WEIGHTS.sameShape),
      read(SettingKey.RECOMMEND_WEIGHT_RATING, DEFAULT_WEIGHTS.rating),
      read(SettingKey.RECOMMEND_WEIGHT_RECENCY, DEFAULT_WEIGHTS.recency),
      read(SettingKey.RECOMMEND_WEIGHT_DISTANCE, DEFAULT_WEIGHTS.distance),
    ]);
    return { works, sameShape, rating, recency, distance };
  }
}
