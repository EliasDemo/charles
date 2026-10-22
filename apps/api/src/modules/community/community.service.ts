import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../common/outbox/outbox.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { publicBarbershopWhere } from '../barbershops/barbershop-access.service';
import { barbershopMedia } from '../images/barbershop-media';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { variantKeys, variantUrl } from '../images/image-variants';
import { ImagesService } from '../images/images.service';
import { LocationsService } from '../locations/locations';
import { EntitlementsService } from '../plans/entitlements.service';
import { CommunityPolicy } from './community-policy';
import type {
  AttendanceDto,
  AttendanceStateDto,
  AuthorPostsQueryDto,
  BlockedUserDto,
  CommentDto,
  CommentPageDto,
  CommentsQueryDto,
  CreateCommentDto,
  CreatePostDto,
  FeedQueryDto,
  FollowStateDto,
  LikeStateDto,
  PostAuthorDto,
  PostDto,
  PostEventInputDto,
  PostMediaDto,
  PostPageDto,
  SavedPostsQueryDto,
  ShareStateDto,
  UpdateCommentDto,
  UpdatePostDto,
} from './dto/community.dto';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;
const PAGE = 20;
/** "Para ti": publicaciones de los últimos 30 días, ordenadas por interacción y frescura. */
const FOR_YOU_DAYS = 30;
/** Avisos de una publicación nueva: hasta este número de seguidores por publicación. */
const NEW_POST_FANOUT = 1000;

export const COMMUNITY_EVENTS = {
  postCreated: 'community.post_created',
  commented: 'community.commented',
  liked: 'community.liked',
} as const;

const postInclude = {
  media: { orderBy: { sortOrder: 'asc' as const } },
  barbershop: { select: { id: true, name: true } },
  authorProfile: { select: { id: true, displayName: true, photoVariants: true, userId: true } },
  promotion: {
    select: { id: true, name: true, type: true, value: true, endsAt: true, deletedAt: true },
  },
} satisfies Prisma.PostInclude;
type PostRow = Prisma.PostGetPayload<{ include: typeof postInclude }>;

const commentInclude = {
  author: { select: { id: true, username: true, photoVariants: true, anonymizedAt: true } },
  mentionUser: { select: { id: true, username: true, photoVariants: true, anonymizedAt: true } },
} satisfies Prisma.PostCommentInclude;
type CommentRow = Prisma.PostCommentGetPayload<{ include: typeof commentInclude }>;

const notFound = (what = 'La publicación no existe.'): AppException =>
  new AppException(ErrorCode.NOT_FOUND, what, HttpStatus.NOT_FOUND);
const hidden = (): AppException =>
  new AppException(
    ErrorCode.POST_HIDDEN,
    'Esta publicación ya no está disponible (fue retirada o está en revisión).',
    HttpStatus.GONE,
  );
const blocked = (): AppException =>
  new AppException(
    ErrorCode.BLOCKED,
    'No puedes interactuar con esta cuenta (hay un bloqueo entre ustedes).',
    HttpStatus.FORBIDDEN,
  );
const invalid = (field: string, constraint: string, message: string): AppException =>
  new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, [
    { field, constraints: [constraint] },
  ]);

/** Cursor de desplazamiento (opaco para la app). */
const offsetOf = (cursor: string | undefined): number => {
  const n = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const cursorFor = (offset: number): string => Buffer.from(String(offset)).toString('base64url');

interface Viewer {
  id: string;
  /** Cuentas bloqueadas por mí o que me bloquearon. */
  blocked: Set<string>;
  /** Barberías donde soy OWNER o MANAGER. */
  staffOf: Set<string>;
  profileId: string | null;
}

/**
 * Comunidad: publicaciones de barberías y barberos (promociones, eventos, trabajos y anuncios),
 * feed, comentarios en dos niveles, me gusta, guardados, asistencia a eventos, seguidores y
 * bloqueos. La moderación (reportes y revisión) está en `CommunityModerationService`.
 */
@Injectable()
export class CommunityService {
  private readonly logger = new Logger(CommunityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly images: ImagesService,
    private readonly locations: LocationsService,
    private readonly entitlements: EntitlementsService,
    private readonly policy: CommunityPolicy,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Quién mira ─────────────

  async viewer(userId: string | null | undefined): Promise<Viewer | null> {
    if (!userId) return null;
    const [blocks, staff, profile] = await Promise.all([
      this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
      }),
      this.prisma.barbershopMember.findMany({
        where: { userId, role: { in: ['OWNER', 'MANAGER'] }, barbershop: { deletedAt: null } },
        select: { barbershopId: true },
      }),
      this.prisma.barberProfile.findUnique({
        where: { userId },
        select: { id: true, deletedAt: true },
      }),
    ]);
    return {
      id: userId,
      blocked: new Set(blocks.map((b) => (b.blockerId === userId ? b.blockedId : b.blockerId))),
      staffOf: new Set(staff.map((s) => s.barbershopId)),
      profileId: profile && !profile.deletedAt ? profile.id : null,
    };
  }

  /** ¿Habla en nombre del autor de la publicación? (creador, OWNER/MANAGER o dueño del perfil). */
  private isAuthorSide(
    post: { createdById: string; barbershopId: string | null; authorProfileId: string | null },
    viewer: Viewer | null,
  ): boolean {
    if (!viewer) return false;
    if (post.barbershopId) return viewer.staffOf.has(post.barbershopId);
    return (
      post.createdById === viewer.id ||
      (!!post.authorProfileId && post.authorProfileId === viewer.profileId)
    );
  }

  // ───────────── Fotos ─────────────

  /** Sube una foto (antes de publicar). Se adjunta con `mediaIds` al crear o editar. */
  async uploadMedia(userId: string, file: Buffer | undefined): Promise<PostMediaDto> {
    await this.policy.limitActions(userId);
    const variants = await this.images.storePostPhoto(file);
    const row = await this.prisma.postMedia.create({
      data: { uploadedById: userId, variants: variants },
    });
    return this.mediaDto(row);
  }

  private mediaDto(row: { id: string; variants: Prisma.JsonValue }): PostMediaDto {
    const large = (row.variants as Record<string, { width?: number; height?: number }> | null)
      ?.large;
    return {
      id: row.id,
      url: variantUrl(this.storage, row.variants, 'large'),
      thumbUrl: variantUrl(this.storage, row.variants, 'thumb'),
      width: large?.width ?? null,
      height: large?.height ?? null,
    };
  }

  // ───────────── Publicaciones ─────────────

  async create(userId: string, dto: CreatePostDto): Promise<PostDto> {
    await this.policy.assertAllowed(dto.body);
    await this.policy.limitPosts(userId);
    const author = await this.resolveAuthor(userId, dto.barbershopId);
    this.assertEvent(dto.type, dto.event);
    if (dto.type !== 'PROMOTION' && dto.promotionId) {
      throw invalid(
        'promotionId',
        'onlyPromotion',
        'Solo las publicaciones de promoción enlazan una promoción.',
      );
    }
    if (dto.type === 'PROMOTION' && dto.promotionId) {
      const promo = await this.prisma.promotion.findFirst({
        where: {
          id: dto.promotionId,
          deletedAt: null,
          barbershopId: author.barbershopId ?? '__none__',
        },
        select: { id: true },
      });
      if (!promo)
        throw invalid(
          'promotionId',
          'ownPromotion',
          'La promoción no existe o no es de tu barbería.',
        );
    }
    if (dto.type !== 'WORK' && (dto.barberProfileId || dto.serviceId)) {
      throw invalid(
        'serviceId',
        'onlyWork',
        'El barbero y el servicio solo van en publicaciones de trabajos.',
      );
    }
    if (dto.serviceId) {
      const service = await this.prisma.service.findFirst({
        where: {
          id: dto.serviceId,
          deletedAt: null,
          barbershopId: author.barbershopId ?? '__none__',
        },
        select: { id: true },
      });
      if (!service)
        throw invalid('serviceId', 'ownService', 'El servicio no existe o no es de tu barbería.');
    }
    if (dto.barberProfileId) {
      const exists = await this.prisma.barberProfile.count({
        where: { id: dto.barberProfileId, deletedAt: null },
      });
      if (!exists) throw invalid('barberProfileId', 'exists', 'El perfil del barbero no existe.');
    }
    const event = dto.type === 'EVENT' ? dto.event! : null;
    const id = await this.prisma.$transaction(async (tx) => {
      const post = await tx.post.create({
        data: {
          type: dto.type,
          barbershopId: author.barbershopId,
          authorProfileId: author.profileId,
          createdById: userId,
          body: dto.body,
          promotionId: dto.promotionId ?? null,
          barberProfileId: dto.barberProfileId ?? null,
          serviceId: dto.serviceId ?? null,
          commentsDisabled: dto.commentsDisabled ?? false,
          ...this.eventData(event),
          latitude: event?.lat ?? author.latitude,
          longitude: event?.lng ?? author.longitude,
          createdAt: new Date(this.clock.now()),
        },
        select: { id: true },
      });
      await this.attachMedia(tx, userId, post.id, dto.mediaIds ?? []);
      await this.outbox.publish(tx, COMMUNITY_EVENTS.postCreated, { postId: post.id });
      return post.id;
    });
    return this.one(userId, id);
  }

  private async resolveAuthor(
    userId: string,
    barbershopId: string | undefined,
  ): Promise<{
    barbershopId: string | null;
    profileId: string | null;
    latitude: number | null;
    longitude: number | null;
  }> {
    if (barbershopId) {
      const member = await this.prisma.barbershopMember.findFirst({
        where: { barbershopId, userId, barbershop: { deletedAt: null } },
        select: { role: true, barbershop: { select: { latitude: true, longitude: true } } },
      });
      if (!member) throw notFound('La barbería no existe.');
      if (member.role !== 'OWNER' && member.role !== 'MANAGER') {
        throw new AppException(
          ErrorCode.FORBIDDEN,
          'Solo el dueño o el encargado publican por la barbería.',
          HttpStatus.FORBIDDEN,
        );
      }
      return {
        barbershopId,
        profileId: null,
        latitude: member.barbershop.latitude,
        longitude: member.barbershop.longitude,
      };
    }
    const profile = await this.prisma.barberProfile.findUnique({
      where: { userId },
      select: { id: true, deletedAt: true, districtId: true },
    });
    if (!profile || profile.deletedAt) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Para publicar a tu nombre, primero crea tu perfil profesional (o indica la barbería).',
        HttpStatus.NOT_FOUND,
      );
    }
    const district = this.locations.byId(profile.districtId);
    return {
      barbershopId: null,
      profileId: profile.id,
      latitude: district?.latitude ?? null,
      longitude: district?.longitude ?? null,
    };
  }

  private assertEvent(type: string, event: PostEventInputDto | undefined): void {
    if (type === 'EVENT' && !event)
      throw invalid('event', 'required', 'Un evento necesita fecha y lugar.');
    if (type !== 'EVENT' && event)
      throw invalid(
        'event',
        'onlyEvent',
        'Solo las publicaciones de evento llevan datos de evento.',
      );
    if (event?.endsAt && event.endsAt <= event.startsAt) {
      throw invalid('event.endsAt', 'afterStart', 'El evento debe terminar después de empezar.');
    }
  }

  private eventData(event: PostEventInputDto | null) {
    return {
      eventStartsAt: event?.startsAt ?? null,
      eventEndsAt: event?.endsAt ?? null,
      eventAddress: event?.address ?? null,
      eventCapacity: event?.capacity ?? null,
    };
  }

  private async attachMedia(
    tx: Tx,
    userId: string,
    postId: string,
    mediaIds: string[],
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    const unique = [...new Set(mediaIds)];
    const rows = await tx.postMedia.findMany({
      where: { id: { in: unique }, uploadedById: userId, OR: [{ postId: null }, { postId }] },
      select: { id: true },
    });
    if (rows.length !== unique.length) {
      throw invalid(
        'mediaIds',
        'ownMedia',
        'Alguna foto no existe, no es tuya o ya está en otra publicación.',
      );
    }
    for (const [i, mediaId] of unique.entries()) {
      await tx.postMedia.update({ where: { id: mediaId }, data: { postId, sortOrder: i } });
    }
  }

  async update(userId: string, postId: string, dto: UpdatePostDto): Promise<PostDto> {
    const viewer = await this.viewer(userId);
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post) throw notFound();
    if (!this.isAuthorSide(post, viewer)) throw notFound();
    if (post.removedAt) throw hidden();
    if (dto.body) await this.policy.assertAllowed(dto.body);
    if (dto.event) this.assertEvent(post.type, dto.event);
    const removedKeys: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      if (dto.mediaIds) {
        const old = await tx.postMedia.findMany({
          where: { postId, id: { notIn: dto.mediaIds } },
          select: { id: true, variants: true },
        });
        for (const m of old) removedKeys.push(...variantKeys(m.variants));
        await tx.postMedia.deleteMany({ where: { id: { in: old.map((m) => m.id) } } });
        await this.attachMedia(tx, userId, postId, dto.mediaIds);
      }
      await tx.post.update({
        where: { id: postId },
        data: {
          ...(dto.body !== undefined ? { body: dto.body } : {}),
          ...(dto.commentsDisabled !== undefined ? { commentsDisabled: dto.commentsDisabled } : {}),
          ...(dto.event
            ? {
                ...this.eventData(dto.event),
                ...(dto.event.lat !== undefined && dto.event.lng !== undefined
                  ? { latitude: dto.event.lat, longitude: dto.event.lng }
                  : {}),
              }
            : {}),
          editedAt: new Date(this.clock.now()),
        },
      });
    });
    if (removedKeys.length) await this.images.deleteFiles(removedKeys);
    return this.one(userId, postId);
  }

  async remove(userId: string, postId: string): Promise<void> {
    const viewer = await this.viewer(userId);
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post || !this.isAuthorSide(post, viewer)) throw notFound();
    await this.prisma.post.update({
      where: { id: postId },
      data: { deletedAt: new Date(this.clock.now()) },
    });
  }

  async pin(userId: string, postId: string, pinned: boolean): Promise<PostDto> {
    const viewer = await this.viewer(userId);
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post || !this.isAuthorSide(post, viewer)) throw notFound();
    await this.prisma.post.update({
      where: { id: postId },
      data: { pinnedAt: pinned ? new Date(this.clock.now()) : null },
    });
    return this.one(userId, postId);
  }

  /** Una publicación (pública). 410 POST_HIDDEN si fue retirada u ocultada por reportes. */
  async one(userId: string | null | undefined, postId: string): Promise<PostDto> {
    const viewer = await this.viewer(userId);
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      include: postInclude,
    });
    if (!post || !(await this.authorVisible(post))) throw notFound();
    if (viewer?.blocked.has(post.createdById)) throw blocked();
    if ((post.removedAt || post.hiddenAt) && !this.isAuthorSide(post, viewer)) throw hidden();
    return (await this.toDtos([post], viewer))[0]!;
  }

  private async authorVisible(post: {
    barbershopId: string | null;
    authorProfileId: string | null;
  }): Promise<boolean> {
    if (post.barbershopId) {
      return (
        (await this.prisma.barbershop.count({ where: publicBarbershopWhere(post.barbershopId) })) >
        0
      );
    }
    return (
      (await this.prisma.barberProfile.count({
        where: { id: post.authorProfileId ?? '', deletedAt: null },
      })) > 0
    );
  }

  // ───────────── Feed ─────────────

  async feed(userId: string | null | undefined, query: FeedQueryDto): Promise<PostPageDto> {
    const viewer = await this.viewer(userId);
    const tab = query.tab ?? 'forYou';
    const limit = query.limit ?? PAGE;
    const offset = offsetOf(query.cursor);
    if (tab === 'nearby' && (query.lat === undefined || query.lng === undefined)) {
      throw invalid('lat', 'required', 'Para "Cerca de ti" envía lat y lng.');
    }
    if (tab === 'following' && !viewer) return { items: [], nextCursor: null };
    const now = new Date(this.clock.now());
    const blockedIds = [...(viewer?.blocked ?? [])];
    const typeFilter = query.type
      ? Prisma.sql`AND p.type = ${query.type}::"PostType"`
      : Prisma.empty;
    const blockFilter = blockedIds.length
      ? Prisma.sql`AND p.created_by <> ALL(${blockedIds}::uuid[])`
      : Prisma.empty;
    const visible = Prisma.sql`
      p.deleted_at IS NULL AND p.removed_at IS NULL AND p.hidden_at IS NULL
      AND (p.barbershop_id IS NULL OR EXISTS (
        SELECT 1 FROM barbershops s WHERE s.id = p.barbershop_id AND s.deleted_at IS NULL
          AND s.status IN ('OPEN', 'TEMPORARILY_CLOSED')))
      AND (p.author_profile_id IS NULL OR EXISTS (
        SELECT 1 FROM barber_profiles bp WHERE bp.id = p.author_profile_id AND bp.deleted_at IS NULL))
      ${typeFilter} ${blockFilter}`;
    const hasPoint = query.lat !== undefined && query.lng !== undefined;
    const distance = hasPoint
      ? Prisma.sql`CASE WHEN p.latitude IS NULL OR p.longitude IS NULL THEN NULL ELSE
          ST_Distance(ST_SetSRID(ST_MakePoint(p.longitude, p.latitude), 4326)::geography,
                      ST_SetSRID(ST_MakePoint(${query.lng!}::float8, ${query.lat!}::float8), 4326)::geography) / 1000 END`
      : Prisma.sql`NULL::float8`;
    let rows: { id: string; distance_km: number | null }[];
    if (tab === 'nearby') {
      const radius = query.radiusKm ?? 30;
      rows = await this.prisma.$queryRaw`
        SELECT p.id::text AS id, ${distance} AS distance_km FROM posts p
         WHERE ${visible} AND p.latitude IS NOT NULL
           AND ST_DWithin(ST_SetSRID(ST_MakePoint(p.longitude, p.latitude), 4326)::geography,
                          ST_SetSRID(ST_MakePoint(${query.lng!}::float8, ${query.lat!}::float8), 4326)::geography,
                          ${radius * 1000}::float8)
         ORDER BY p.created_at DESC, p.id DESC
         OFFSET ${offset} LIMIT ${limit + 1}`;
    } else if (tab === 'following') {
      rows = await this.prisma.$queryRaw`
        SELECT p.id::text AS id, ${distance} AS distance_km FROM posts p
         WHERE ${visible} AND (
           p.barbershop_id IN (SELECT barbershop_id FROM follows WHERE follower_id = ${viewer!.id}::uuid AND barbershop_id IS NOT NULL)
           OR p.author_profile_id IN (SELECT barber_profile_id FROM follows WHERE follower_id = ${viewer!.id}::uuid AND barber_profile_id IS NOT NULL))
         ORDER BY p.created_at DESC, p.id DESC
         OFFSET ${offset} LIMIT ${limit + 1}`;
    } else {
      const since = new Date(now.getTime() - FOR_YOU_DAYS * DAY_MS);
      const followBoost = viewer
        ? Prisma.sql`* CASE WHEN p.barbershop_id IN (SELECT barbershop_id FROM follows WHERE follower_id = ${viewer.id}::uuid AND barbershop_id IS NOT NULL)
              OR p.author_profile_id IN (SELECT barber_profile_id FROM follows WHERE follower_id = ${viewer.id}::uuid AND barber_profile_id IS NOT NULL)
              THEN 2 ELSE 1 END`
        : Prisma.empty;
      rows = await this.prisma.$queryRaw`
        SELECT p.id::text AS id, ${distance} AS distance_km FROM posts p
         WHERE ${visible} AND p.created_at >= ${since}
         ORDER BY ((p.like_count + 2 * p.comment_count + 3 * p.share_count + p.going_count + 1)::float8
                   / power(GREATEST(EXTRACT(EPOCH FROM (${now}::timestamptz - p.created_at)) / 3600, 0) + 2, 1.5)
                   ${followBoost}) DESC, p.id DESC
         OFFSET ${offset} LIMIT ${limit + 1}`;
    }
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = await this.load(
      page.map((r) => r.id),
      viewer,
    );
    const km = new Map(page.map((r) => [r.id, r.distance_km]));
    return {
      items: items.map((p) => ({ ...p, distanceKm: round1(km.get(p.id) ?? null) })),
      nextCursor: hasMore ? cursorFor(offset + limit) : null,
    };
  }

  /** Publicaciones de una barbería o de un perfil profesional (fijadas primero). */
  async byAuthor(
    userId: string | null | undefined,
    author: { barbershopId?: string; profileId?: string },
    query: AuthorPostsQueryDto,
  ): Promise<PostPageDto> {
    if (author.barbershopId) {
      const ok = await this.prisma.barbershop.count({
        where: publicBarbershopWhere(author.barbershopId),
      });
      if (!ok) throw notFound('La barbería no existe.');
    } else {
      const ok = await this.prisma.barberProfile.count({
        where: { id: author.profileId, deletedAt: null },
      });
      if (!ok) throw notFound('El perfil no existe.');
    }
    const viewer = await this.viewer(userId);
    const limit = query.limit ?? PAGE;
    const offset = offsetOf(query.cursor);
    const rows = await this.prisma.post.findMany({
      where: {
        ...(author.barbershopId
          ? { barbershopId: author.barbershopId }
          : { authorProfileId: author.profileId }),
        deletedAt: null,
        removedAt: null,
        hiddenAt: null,
        ...(query.type ? { type: query.type } : {}),
        ...(viewer?.blocked.size ? { createdById: { notIn: [...viewer.blocked] } } : {}),
      },
      orderBy: [
        { pinnedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      skip: offset,
      take: limit + 1,
      include: postInclude,
    });
    const hasMore = rows.length > limit;
    return {
      items: await this.toDtos(rows.slice(0, limit), viewer),
      nextCursor: hasMore ? cursorFor(offset + limit) : null,
    };
  }

  async saved(userId: string, query: SavedPostsQueryDto): Promise<PostPageDto> {
    const viewer = await this.viewer(userId);
    const limit = query.limit ?? PAGE;
    const offset = offsetOf(query.cursor);
    const saves = await this.prisma.postSave.findMany({
      where: { userId, post: { deletedAt: null, removedAt: null, hiddenAt: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit + 1,
      select: { postId: true },
    });
    const hasMore = saves.length > limit;
    return {
      items: await this.load(
        saves.slice(0, limit).map((s) => s.postId),
        viewer,
      ),
      nextCursor: hasMore ? cursorFor(offset + limit) : null,
    };
  }

  private async load(ids: string[], viewer: Viewer | null): Promise<PostDto[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.post.findMany({
      where: { id: { in: ids } },
      include: postInclude,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return this.toDtos(
      ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
      viewer,
    );
  }

  private async toDtos(rows: PostRow[], viewer: Viewer | null): Promise<PostDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const shopIds = [...new Set(rows.flatMap((r) => (r.barbershopId ? [r.barbershopId] : [])))];
    const profileIds = [
      ...new Set(rows.flatMap((r) => (r.authorProfileId ? [r.authorProfileId] : []))),
    ];
    const [media, shopFollowers, profileFollowers, likes, saves, follows, attendance, verified] =
      await Promise.all([
        barbershopMedia(this.prisma, this.storage, shopIds),
        shopIds.length
          ? this.prisma.follow.groupBy({
              by: ['barbershopId'],
              where: { barbershopId: { in: shopIds } },
              _count: { _all: true },
            })
          : [],
        profileIds.length
          ? this.prisma.follow.groupBy({
              by: ['barberProfileId'],
              where: { barberProfileId: { in: profileIds } },
              _count: { _all: true },
            })
          : [],
        viewer
          ? this.prisma.postLike.findMany({
              where: { userId: viewer.id, postId: { in: ids } },
              select: { postId: true },
            })
          : [],
        viewer
          ? this.prisma.postSave.findMany({
              where: { userId: viewer.id, postId: { in: ids } },
              select: { postId: true },
            })
          : [],
        viewer
          ? this.prisma.follow.findMany({
              where: {
                followerId: viewer.id,
                OR: [{ barbershopId: { in: shopIds } }, { barberProfileId: { in: profileIds } }],
              },
              select: { barbershopId: true, barberProfileId: true },
            })
          : [],
        viewer
          ? this.prisma.eventAttendance.findMany({
              where: { userId: viewer.id, postId: { in: ids } },
              select: { postId: true, status: true },
            })
          : [],
        Promise.all(
          shopIds.map(async (id) => {
            const plan = await this.entitlements.effective(id);
            return [
              id,
              plan.values !== null && (plan.values.get('verified_badge') ?? 0) > 0,
            ] as const;
          }),
        ),
      ]);
    const shopCount = new Map(shopFollowers.map((f) => [f.barbershopId, f._count._all]));
    const profileCount = new Map(profileFollowers.map((f) => [f.barberProfileId, f._count._all]));
    const liked = new Set(likes.map((l) => l.postId));
    const savedSet = new Set(saves.map((s) => s.postId));
    const followed = new Set(follows.map((f) => f.barbershopId ?? f.barberProfileId));
    const going = new Map(attendance.map((a) => [a.postId, a.status]));
    const verifiedSet = new Set(verified.filter(([, v]) => v).map(([id]) => id));
    return rows.map((p) => {
      const author: PostAuthorDto = p.barbershop
        ? {
            kind: 'BARBERSHOP',
            id: p.barbershop.id,
            name: p.barbershop.name,
            photoUrl: media.get(p.barbershop.id)?.logoUrl ?? null,
            verified: verifiedSet.has(p.barbershop.id),
            followers: shopCount.get(p.barbershop.id) ?? 0,
          }
        : {
            kind: 'PROFESSIONAL',
            id: p.authorProfile!.id,
            name: p.authorProfile!.displayName,
            photoUrl: variantUrl(this.storage, p.authorProfile!.photoVariants, 'square'),
            verified: false,
            followers: profileCount.get(p.authorProfile!.id) ?? 0,
          };
      const authorSide = this.isAuthorSide(p, viewer);
      return {
        id: p.id,
        type: p.type,
        author,
        body: p.body,
        media: p.media.map((m) => this.mediaDto(m)),
        promotion:
          p.promotion && !p.promotion.deletedAt
            ? {
                id: p.promotion.id,
                name: p.promotion.name,
                type: p.promotion.type,
                value: p.promotion.value,
                endsAt: p.promotion.endsAt,
              }
            : null,
        event:
          p.type === 'EVENT' && p.eventStartsAt
            ? {
                startsAt: p.eventStartsAt,
                endsAt: p.eventEndsAt,
                address: p.eventAddress ?? '',
                lat: p.latitude,
                lng: p.longitude,
                capacity: p.eventCapacity,
                going: p.goingCount,
                interested: p.interestedCount,
                full: p.eventCapacity !== null && p.goingCount >= p.eventCapacity,
              }
            : null,
        barberProfileId: p.barberProfileId,
        serviceId: p.serviceId,
        counts: { likes: p.likeCount, comments: p.commentCount, shares: p.shareCount },
        distanceKm: null,
        commentsDisabled: p.commentsDisabled,
        pinned: p.pinnedAt !== null,
        shareUrl: this.shareUrl(p.id),
        createdAt: p.createdAt,
        editedAt: p.editedAt,
        likedByMe: liked.has(p.id),
        savedByMe: savedSet.has(p.id),
        followingAuthor: followed.has(author.id),
        myEventStatus: going.get(p.id) ?? 'NONE',
        canEdit: authorSide,
        canDelete: authorSide,
        canPin: authorSide,
      };
    });
  }

  shareUrl(postId: string): string {
    const base =
      this.config.payments.publicApiUrl ?? `http://localhost:${process.env.PORT ?? 3000}`;
    return `${base}/api/v1/p/${postId}`;
  }

  /** Publicación visible para interactuar (me gusta, comentar, guardar, asistir). */
  private async interactable(
    postId: string,
    viewer: Viewer,
  ): Promise<{
    id: string;
    createdById: string;
    barbershopId: string | null;
    authorProfileId: string | null;
    commentsDisabled: boolean;
    type: string;
  }> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        createdById: true,
        barbershopId: true,
        authorProfileId: true,
        commentsDisabled: true,
        type: true,
        removedAt: true,
        hiddenAt: true,
      },
    });
    if (!post || !(await this.authorVisible(post))) throw notFound();
    if (post.removedAt || post.hiddenAt) throw hidden();
    if (viewer.blocked.has(post.createdById)) throw blocked();
    return post;
  }

  // ───────────── Me gusta, guardar, compartir ─────────────

  async likePost(userId: string, postId: string, like: boolean): Promise<LikeStateDto> {
    const viewer = (await this.viewer(userId))!;
    await this.policy.limitActions(userId);
    await this.interactable(postId, viewer);
    const likes = await this.prisma.$transaction(async (tx) => {
      const changed = like
        ? (await tx.postLike.createMany({ data: [{ postId, userId }], skipDuplicates: true })).count
        : (await tx.postLike.deleteMany({ where: { postId, userId } })).count;
      if (changed) {
        const updated = await tx.post.update({
          where: { id: postId },
          data: { likeCount: { increment: like ? 1 : -1 } },
          select: { likeCount: true },
        });
        if (like) await this.outbox.publish(tx, COMMUNITY_EVENTS.liked, { postId, userId });
        return updated.likeCount;
      }
      return (
        await tx.post.findUniqueOrThrow({ where: { id: postId }, select: { likeCount: true } })
      ).likeCount;
    });
    return { liked: like, likes };
  }

  async likeComment(userId: string, commentId: string, like: boolean): Promise<LikeStateDto> {
    const viewer = (await this.viewer(userId))!;
    await this.policy.limitActions(userId);
    const comment = await this.visibleComment(commentId, viewer);
    await this.interactable(comment.postId, viewer);
    const likes = await this.prisma.$transaction(async (tx) => {
      const changed = like
        ? (await tx.commentLike.createMany({ data: [{ commentId, userId }], skipDuplicates: true }))
            .count
        : (await tx.commentLike.deleteMany({ where: { commentId, userId } })).count;
      if (changed) {
        const updated = await tx.postComment.update({
          where: { id: commentId },
          data: { likeCount: { increment: like ? 1 : -1 } },
          select: { likeCount: true },
        });
        if (like) await this.outbox.publish(tx, COMMUNITY_EVENTS.liked, { commentId, userId });
        return updated.likeCount;
      }
      return (
        await tx.postComment.findUniqueOrThrow({
          where: { id: commentId },
          select: { likeCount: true },
        })
      ).likeCount;
    });
    return { liked: like, likes };
  }

  /** Me gusta en una valoración publicada (no oculta). */
  async likeReview(userId: string, reviewId: string, like: boolean): Promise<LikeStateDto> {
    await this.policy.limitActions(userId);
    const review = await this.prisma.review.findFirst({
      where: { id: reviewId, deletedAt: null, status: { not: 'HIDDEN' } },
      select: { id: true },
    });
    if (!review) throw notFound('La valoración no existe.');
    const likes = await this.prisma.$transaction(async (tx) => {
      const changed = like
        ? (await tx.reviewLike.createMany({ data: [{ reviewId, userId }], skipDuplicates: true }))
            .count
        : (await tx.reviewLike.deleteMany({ where: { reviewId, userId } })).count;
      if (changed) {
        return (
          await tx.review.update({
            where: { id: reviewId },
            data: { likeCount: { increment: like ? 1 : -1 } },
            select: { likeCount: true },
          })
        ).likeCount;
      }
      return (
        await tx.review.findUniqueOrThrow({ where: { id: reviewId }, select: { likeCount: true } })
      ).likeCount;
    });
    return { liked: like, likes };
  }

  async save(userId: string, postId: string, save: boolean): Promise<{ saved: boolean }> {
    const viewer = (await this.viewer(userId))!;
    await this.policy.limitActions(userId);
    if (save) {
      await this.interactable(postId, viewer);
      await this.prisma.postSave.createMany({ data: [{ postId, userId }], skipDuplicates: true });
    } else {
      await this.prisma.postSave.deleteMany({ where: { postId, userId } });
    }
    return { saved: save };
  }

  /** Cuenta un compartido (sin sesión también: el límite global por IP aplica). */
  async share(postId: string): Promise<ShareStateDto> {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null, removedAt: null, hiddenAt: null },
      select: { id: true },
    });
    if (!post) throw notFound();
    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { shareCount: { increment: 1 } },
      select: { shareCount: true },
    });
    return { shares: updated.shareCount, shareUrl: this.shareUrl(postId) };
  }

  // ───────────── Eventos ─────────────

  async attendance(
    userId: string,
    postId: string,
    dto: AttendanceDto,
  ): Promise<AttendanceStateDto> {
    const viewer = (await this.viewer(userId))!;
    await this.policy.limitActions(userId);
    const post = await this.interactable(postId, viewer);
    if (post.type !== 'EVENT')
      throw invalid('status', 'onlyEvent', 'Solo los eventos tienen asistencia.');
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        {
          going_count: number;
          interested_count: number;
          event_capacity: number | null;
          event_ends_at: Date | null;
          event_starts_at: Date | null;
        }[]
      >`SELECT going_count, interested_count, event_capacity, event_ends_at, event_starts_at
          FROM posts WHERE id = ${postId}::uuid FOR UPDATE`;
      const ends = locked!.event_ends_at ?? locked!.event_starts_at;
      if (dto.status !== 'NONE' && ends && ends.getTime() < this.clock.now()) {
        throw new AppException(ErrorCode.EVENT_FULL, 'El evento ya terminó.', HttpStatus.CONFLICT);
      }
      const current = await tx.eventAttendance.findUnique({
        where: { postId_userId: { postId, userId } },
      });
      const before = current?.status ?? 'NONE';
      if (before === dto.status) {
        return {
          status: dto.status,
          going: locked!.going_count,
          interested: locked!.interested_count,
          capacity: locked!.event_capacity,
        };
      }
      if (
        dto.status === 'GOING' &&
        locked!.event_capacity !== null &&
        locked!.going_count >= locked!.event_capacity
      ) {
        throw new AppException(
          ErrorCode.EVENT_FULL,
          'El evento ya no tiene cupos.',
          HttpStatus.CONFLICT,
        );
      }
      if (dto.status === 'NONE')
        await tx.eventAttendance.delete({ where: { postId_userId: { postId, userId } } });
      else {
        await tx.eventAttendance.upsert({
          where: { postId_userId: { postId, userId } },
          create: { postId, userId, status: dto.status },
          update: { status: dto.status },
        });
      }
      const delta = (s: string) => ({
        going: (dto.status === 'GOING' ? 1 : 0) - (before === 'GOING' ? 1 : 0),
        interested: (dto.status === 'INTERESTED' ? 1 : 0) - (before === 'INTERESTED' ? 1 : 0),
        s,
      });
      const d = delta(dto.status);
      const updated = await tx.post.update({
        where: { id: postId },
        data: { goingCount: { increment: d.going }, interestedCount: { increment: d.interested } },
        select: { goingCount: true, interestedCount: true, eventCapacity: true },
      });
      return {
        status: dto.status,
        going: updated.goingCount,
        interested: updated.interestedCount,
        capacity: updated.eventCapacity,
      };
    });
  }

  // ───────────── Comentarios ─────────────

  private async visibleComment(commentId: string, viewer: Viewer | null): Promise<CommentRow> {
    const comment = await this.prisma.postComment.findFirst({
      where: { id: commentId, deletedAt: null, removedAt: null, hiddenAt: null },
      include: commentInclude,
    });
    if (!comment) throw notFound('El comentario no existe.');
    if (viewer?.blocked.has(comment.authorId)) throw blocked();
    return comment;
  }

  async comments(
    userId: string | null | undefined,
    postId: string,
    query: CommentsQueryDto,
  ): Promise<CommentPageDto> {
    const viewer = await this.viewer(userId);
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post || !(await this.authorVisible(post))) throw notFound();
    if ((post.removedAt || post.hiddenAt) && !this.isAuthorSide(post, viewer)) throw hidden();
    const limit = query.limit ?? PAGE;
    const offset = offsetOf(query.cursor);
    const rows = await this.prisma.postComment.findMany({
      where: {
        postId,
        parentId: query.parentId ?? null,
        deletedAt: null,
        removedAt: null,
        hiddenAt: null,
        ...(viewer?.blocked.size ? { authorId: { notIn: [...viewer.blocked] } } : {}),
      },
      orderBy: query.parentId
        ? [{ createdAt: 'asc' }, { id: 'asc' }]
        : [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit + 1,
      include: commentInclude,
    });
    const hasMore = rows.length > limit;
    return {
      items: await this.commentDtos(rows.slice(0, limit), post, viewer),
      nextCursor: hasMore ? cursorFor(offset + limit) : null,
    };
  }

  async comment(userId: string, postId: string, dto: CreateCommentDto): Promise<CommentDto> {
    const viewer = (await this.viewer(userId))!;
    await this.policy.assertAllowed(dto.body);
    await this.policy.limitComments(userId);
    const post = await this.interactable(postId, viewer);
    if (post.commentsDisabled) {
      throw new AppException(
        ErrorCode.COMMENTS_DISABLED,
        'El autor desactivó los comentarios.',
        HttpStatus.CONFLICT,
      );
    }
    if (dto.parentId) {
      const parent = await this.prisma.postComment.findFirst({
        where: { id: dto.parentId, postId, deletedAt: null, removedAt: null },
        select: { parentId: true, authorId: true },
      });
      if (!parent) throw invalid('parentId', 'exists', 'El comentario al que respondes no existe.');
      if (parent.parentId) {
        throw invalid(
          'parentId',
          'topLevel',
          'Responde al comentario principal y menciona a la persona (mentionUserId).',
        );
      }
      if (viewer.blocked.has(parent.authorId)) throw blocked();
    }
    if (dto.mentionUserId) {
      if (viewer.blocked.has(dto.mentionUserId)) throw blocked();
      const exists = await this.prisma.user.count({
        where: { id: dto.mentionUserId, deletedAt: null },
      });
      if (!exists) throw invalid('mentionUserId', 'exists', 'La cuenta mencionada no existe.');
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await tx.postComment.create({
        data: {
          postId,
          authorId: userId,
          parentId: dto.parentId ?? null,
          mentionUserId: dto.mentionUserId ?? null,
          body: dto.body,
          createdAt: new Date(this.clock.now()),
        },
        select: { id: true },
      });
      await tx.post.update({ where: { id: postId }, data: { commentCount: { increment: 1 } } });
      if (dto.parentId) {
        await tx.postComment.update({
          where: { id: dto.parentId },
          data: { replyCount: { increment: 1 } },
        });
      }
      await this.outbox.publish(tx, COMMUNITY_EVENTS.commented, { commentId: created.id });
      return created.id;
    });
    return this.commentOne(id, viewer);
  }

  private async commentOne(commentId: string, viewer: Viewer | null): Promise<CommentDto> {
    const row = await this.prisma.postComment.findUniqueOrThrow({
      where: { id: commentId },
      include: commentInclude,
    });
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: row.postId } });
    return (await this.commentDtos([row], post, viewer))[0]!;
  }

  async updateComment(
    userId: string,
    commentId: string,
    dto: UpdateCommentDto,
  ): Promise<CommentDto> {
    const viewer = (await this.viewer(userId))!;
    const row = await this.visibleComment(commentId, viewer);
    if (row.authorId !== userId) throw notFound('El comentario no existe.');
    await this.policy.assertAllowed(dto.body);
    await this.prisma.postComment.update({
      where: { id: commentId },
      data: { body: dto.body, editedAt: new Date(this.clock.now()) },
    });
    return this.commentOne(commentId, viewer);
  }

  /** Lo borra su autor o el autor de la publicación. */
  async removeComment(userId: string, commentId: string): Promise<void> {
    const viewer = (await this.viewer(userId))!;
    const row = await this.prisma.postComment.findFirst({
      where: { id: commentId, deletedAt: null },
    });
    if (!row) throw notFound('El comentario no existe.');
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: row.postId } });
    if (row.authorId !== userId && !this.isAuthorSide(post, viewer))
      throw notFound('El comentario no existe.');
    await this.prisma.$transaction(async (tx) => {
      await tx.postComment.update({
        where: { id: commentId },
        data: { deletedAt: new Date(this.clock.now()) },
      });
      const visibleReplies = row.parentId ? 0 : row.replyCount;
      await tx.post.update({
        where: { id: row.postId },
        data: { commentCount: { decrement: 1 + visibleReplies } },
      });
      if (row.parentId) {
        await tx.postComment.update({
          where: { id: row.parentId },
          data: { replyCount: { decrement: 1 } },
        });
      }
    });
  }

  async pinComment(userId: string, commentId: string, pinned: boolean): Promise<CommentDto> {
    const viewer = (await this.viewer(userId))!;
    const row = await this.visibleComment(commentId, viewer);
    const post = await this.prisma.post.findUniqueOrThrow({ where: { id: row.postId } });
    if (!this.isAuthorSide(post, viewer)) throw notFound('El comentario no existe.');
    if (row.parentId)
      throw invalid('commentId', 'topLevel', 'Solo se fijan comentarios principales.');
    await this.prisma.postComment.update({
      where: { id: commentId },
      data: { pinnedAt: pinned ? new Date(this.clock.now()) : null },
    });
    return this.commentOne(commentId, viewer);
  }

  private async commentDtos(
    rows: CommentRow[],
    post: { createdById: string; barbershopId: string | null; authorProfileId: string | null },
    viewer: Viewer | null,
  ): Promise<CommentDto[]> {
    if (rows.length === 0) return [];
    const liked = viewer
      ? new Set(
          (
            await this.prisma.commentLike.findMany({
              where: { userId: viewer.id, commentId: { in: rows.map((r) => r.id) } },
              select: { commentId: true },
            })
          ).map((l) => l.commentId),
        )
      : new Set<string>();
    // "Oficial": quien escribió es el creador, del equipo de la barbería o el dueño del perfil.
    const officialIds = new Set<string>([post.createdById]);
    if (post.barbershopId) {
      const staff = await this.prisma.barbershopMember.findMany({
        where: { barbershopId: post.barbershopId, role: { in: ['OWNER', 'MANAGER'] } },
        select: { userId: true },
      });
      for (const s of staff) officialIds.add(s.userId);
    } else if (post.authorProfileId) {
      const profile = await this.prisma.barberProfile.findUnique({
        where: { id: post.authorProfileId },
        select: { userId: true },
      });
      if (profile) officialIds.add(profile.userId);
    }
    const authorSide = this.isAuthorSide(post, viewer);
    const card = (u: CommentRow['author'] | null) =>
      u
        ? {
            userId: u.id,
            username: u.anonymizedAt ? 'Cuenta eliminada' : u.username,
            photoUrl: u.anonymizedAt ? null : variantUrl(this.storage, u.photoVariants, 'square'),
          }
        : null;
    return rows.map((r) => ({
      id: r.id,
      postId: r.postId,
      parentId: r.parentId,
      author: card(r.author)!,
      authorIsOfficial: officialIds.has(r.authorId),
      mention: card(r.mentionUser),
      body: r.body,
      likes: r.likeCount,
      replies: r.replyCount,
      likedByMe: liked.has(r.id),
      pinned: r.pinnedAt !== null,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      canEdit: viewer?.id === r.authorId,
      canDelete: viewer?.id === r.authorId || authorSide,
      canPin: authorSide && r.parentId === null,
    }));
  }

  // ───────────── Seguir ─────────────

  async followBarbershop(
    userId: string,
    barbershopId: string,
    follow: boolean,
  ): Promise<FollowStateDto> {
    await this.policy.limitActions(userId);
    const ok = await this.prisma.barbershop.count({ where: publicBarbershopWhere(barbershopId) });
    if (!ok) throw notFound('La barbería no existe.');
    if (follow)
      await this.prisma.follow.createMany({
        data: [{ followerId: userId, barbershopId }],
        skipDuplicates: true,
      });
    else await this.prisma.follow.deleteMany({ where: { followerId: userId, barbershopId } });
    return {
      following: follow,
      followers: await this.prisma.follow.count({ where: { barbershopId } }),
    };
  }

  async followProfile(
    userId: string,
    barberProfileId: string,
    follow: boolean,
  ): Promise<FollowStateDto> {
    await this.policy.limitActions(userId);
    const profile = await this.prisma.barberProfile.findFirst({
      where: { id: barberProfileId, deletedAt: null },
      select: { userId: true },
    });
    if (!profile) throw notFound('El perfil no existe.');
    const viewer = (await this.viewer(userId))!;
    if (follow && viewer.blocked.has(profile.userId)) throw blocked();
    if (follow)
      await this.prisma.follow.createMany({
        data: [{ followerId: userId, barberProfileId }],
        skipDuplicates: true,
      });
    else await this.prisma.follow.deleteMany({ where: { followerId: userId, barberProfileId } });
    return {
      following: follow,
      followers: await this.prisma.follow.count({ where: { barberProfileId } }),
    };
  }

  /** Seguidores (y si lo sigo) de una barbería o perfil, para sus pantallas. */
  async followState(
    userId: string | null | undefined,
    target: { barbershopId?: string; barberProfileId?: string },
  ): Promise<FollowStateDto> {
    const where = target.barbershopId
      ? { barbershopId: target.barbershopId }
      : { barberProfileId: target.barberProfileId };
    const [followers, mine] = await Promise.all([
      this.prisma.follow.count({ where }),
      userId ? this.prisma.follow.count({ where: { ...where, followerId: userId } }) : 0,
    ]);
    return { following: mine > 0, followers };
  }

  // ───────────── Bloqueos ─────────────

  async block(userId: string, targetId: string, block: boolean): Promise<{ blocked: boolean }> {
    if (userId === targetId) throw invalid('userId', 'notSelf', 'No puedes bloquearte a ti mismo.');
    await this.policy.limitActions(userId);
    const exists = await this.prisma.user.count({ where: { id: targetId } });
    if (!exists) throw notFound('La cuenta no existe.');
    if (block) {
      await this.prisma.$transaction(async (tx) => {
        await tx.userBlock.createMany({
          data: [{ blockerId: userId, blockedId: targetId }],
          skipDuplicates: true,
        });
        // Al bloquear se dejan de seguir mutuamente los perfiles profesionales.
        await tx.follow.deleteMany({
          where: {
            OR: [
              { followerId: userId, barberProfile: { userId: targetId } },
              { followerId: targetId, barberProfile: { userId } },
            ],
          },
        });
      });
    } else {
      await this.prisma.userBlock.deleteMany({ where: { blockerId: userId, blockedId: targetId } });
    }
    return { blocked: block };
  }

  async blocks(userId: string): Promise<BlockedUserDto[]> {
    const rows = await this.prisma.userBlock.findMany({
      where: { blockerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        createdAt: true,
        blocked: { select: { id: true, username: true, photoVariants: true } },
      },
    });
    return rows.map((r) => ({
      userId: r.blocked.id,
      username: r.blocked.username,
      photoUrl: variantUrl(this.storage, r.blocked.photoVariants, 'square'),
      blockedAt: r.createdAt,
    }));
  }

  // ───────────── Para los avisos ─────────────

  /** Seguidores a avisar de una publicación nueva (sin bloqueos con el autor). */
  async followersToNotify(
    postId: string,
  ): Promise<{ userIds: string[]; authorName: string; type: string } | null> {
    const post = await this.prisma.post.findUnique({ where: { id: postId }, include: postInclude });
    if (!post || post.deletedAt || post.removedAt) return null;
    const followers = await this.prisma.follow.findMany({
      where: post.barbershopId
        ? { barbershopId: post.barbershopId }
        : { barberProfileId: post.authorProfileId },
      select: { followerId: true },
      take: NEW_POST_FANOUT,
    });
    const blocks = await this.prisma.userBlock.findMany({
      where: { OR: [{ blockerId: post.createdById }, { blockedId: post.createdById }] },
      select: { blockerId: true, blockedId: true },
    });
    const excluded = new Set(blocks.flatMap((b) => [b.blockerId, b.blockedId]));
    excluded.add(post.createdById);
    return {
      userIds: followers.map((f) => f.followerId).filter((id) => !excluded.has(id)),
      authorName: post.barbershop?.name ?? post.authorProfile?.displayName ?? 'Charles',
      type: post.type,
    };
  }
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);
