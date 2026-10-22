import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { type AuthUser, CurrentUser, OptionalUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import {
  AdminAccessGuard,
  CurrentStaff,
  type StaffActor,
  SupportOrAdmin,
} from '../admin/admin-access';
import { escapeHtml, htmlPage, messagePage, sendPage, BASE_CSP } from '../payments/checkout-pages';
import { ImageUploadRateLimitGuard } from '../images/image-rate-limit';
import { SingleFile, UPLOAD_NOTE, UploadDocs, type UploadedImage } from '../images/upload';
import { CommunityModerationService } from './community-moderation.service';
import { CommunityService } from './community.service';
import {
  AdminContentReportDto,
  AdminReportsQueryDto,
  AttendanceDto,
  AttendanceStateDto,
  AuthorPostsQueryDto,
  BlockedUserDto,
  BlockStateDto,
  CommentDto,
  CommentPageDto,
  CommentsQueryDto,
  CreateCommentDto,
  CreateContentReportDto,
  CreatePostDto,
  FeedQueryDto,
  FollowStateDto,
  LikeStateDto,
  PinCommentDto,
  PinPostDto,
  PostDto,
  PostMediaUploadDto,
  PostPageDto,
  ResolveReportDto,
  SavedPostsQueryDto,
  SaveStateDto,
  ShareStateDto,
  UpdateCommentDto,
  UpdatePostDto,
  UploadedPostMediaDto,
} from './dto/community.dto';

const uuid = new ParseUUIDPipe();

@ApiTags('community')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({
  type: ErrorResponseDto,
  description: 'BLOCKED: hay un bloqueo con el autor.',
})
@ApiGoneResponse({
  type: ErrorResponseDto,
  description: 'POST_HIDDEN: retirada u oculta por reportes.',
})
@ApiTooManyRequestsResponse({ type: ErrorResponseDto })
@Controller()
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  // ───────────── Feed y publicaciones ─────────────

  @Public()
  @RateLimit('public')
  @Get('feed')
  @ApiOperation({
    summary: 'Feed de la comunidad (sin sesión también)',
    description:
      'forYou: interacción y frescura (30 días). nearby: exige lat/lng (radiusKm, def. 30). following: ' +
      'barberías y perfiles que sigo (vacío sin sesión). Cursor opaco.',
  })
  @ApiOkResponse({ type: PostPageDto })
  feed(@OptionalUser() user: AuthUser | null, @Query() query: FeedQueryDto): Promise<PostPageDto> {
    return this.community.feed(user?.id, query);
  }

  @ApiBearerAuth()
  @Post('posts/media')
  @UseGuards(ImageUploadRateLimitGuard)
  @SingleFile()
  @UploadDocs(PostMediaUploadDto)
  @ApiOperation({
    summary: 'Subir una foto para una publicación (antes de publicar)',
    description: `${UPLOAD_NOTE} Luego envía su id en mediaIds (máx. 10 por publicación).`,
  })
  @ApiCreatedResponse({ type: UploadedPostMediaDto })
  uploadMedia(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: UploadedImage | undefined,
  ): Promise<UploadedPostMediaDto> {
    return this.community.uploadMedia(user.id, file?.buffer);
  }

  @ApiBearerAuth()
  @Post('posts')
  @ApiOperation({
    summary: 'Publicar (como barbería si envías barbershopId; si no, como mi perfil profesional)',
    description:
      'PROMOTION puede enlazar promotionId (de la barbería). EVENT exige event. WORK admite ' +
      'barberProfileId y serviceId. 400 CONTENT_NOT_ALLOWED con palabras no permitidas.',
  })
  @ApiCreatedResponse({ type: PostDto })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePostDto): Promise<PostDto> {
    return this.community.create(user.id, dto);
  }

  @Public()
  @RateLimit('public')
  @Get('posts/:id')
  @ApiOperation({ summary: 'Una publicación' })
  @ApiOkResponse({ type: PostDto })
  one(@OptionalUser() user: AuthUser | null, @Param('id', uuid) id: string): Promise<PostDto> {
    return this.community.one(user?.id, id);
  }

  @ApiBearerAuth()
  @Patch('posts/:id')
  @ApiOperation({
    summary: 'Editar (autor: creador, OWNER/MANAGER de la barbería o dueño del perfil)',
  })
  @ApiOkResponse({ type: PostDto })
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdatePostDto,
  ): Promise<PostDto> {
    return this.community.update(user.id, id, dto);
  }

  @ApiBearerAuth()
  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar (autor)' })
  @ApiNoContentResponse()
  remove(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    return this.community.remove(user.id, id);
  }

  @ApiBearerAuth()
  @Put('posts/:id/pin')
  @ApiOperation({ summary: 'Fijar o soltar en el perfil del autor' })
  @ApiOkResponse({ type: PostDto })
  pin(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: PinPostDto,
  ): Promise<PostDto> {
    return this.community.pin(user.id, id, dto.pinned);
  }

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/posts')
  @ApiOperation({ summary: 'Publicaciones de una barbería (fijadas primero)' })
  @ApiOkResponse({ type: PostPageDto })
  byShop(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
    @Query() query: AuthorPostsQueryDto,
  ): Promise<PostPageDto> {
    return this.community.byAuthor(user?.id, { barbershopId: id }, query);
  }

  @Public()
  @RateLimit('public')
  @Get('professional-profiles/:id/posts')
  @ApiOperation({ summary: 'Publicaciones de un perfil profesional (fijadas primero)' })
  @ApiOkResponse({ type: PostPageDto })
  byProfile(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
    @Query() query: AuthorPostsQueryDto,
  ): Promise<PostPageDto> {
    return this.community.byAuthor(user?.id, { profileId: id }, query);
  }

  // ───────────── Me gusta, guardar, compartir, eventos ─────────────

  @ApiBearerAuth()
  @Put('posts/:id/like')
  @ApiOperation({ summary: 'Me gusta (idempotente)' })
  @ApiOkResponse({ type: LikeStateDto })
  like(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<LikeStateDto> {
    return this.community.likePost(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('posts/:id/like')
  @ApiOperation({ summary: 'Quitar me gusta (idempotente)' })
  @ApiOkResponse({ type: LikeStateDto })
  unlike(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<LikeStateDto> {
    return this.community.likePost(user.id, id, false);
  }

  @ApiBearerAuth()
  @Put('posts/:id/save')
  @ApiOperation({ summary: 'Guardar (idempotente)' })
  @ApiOkResponse({ type: SaveStateDto })
  save(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<SaveStateDto> {
    return this.community.save(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('posts/:id/save')
  @ApiOperation({ summary: 'Quitar de guardados (idempotente)' })
  @ApiOkResponse({ type: SaveStateDto })
  unsave(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<SaveStateDto> {
    return this.community.save(user.id, id, false);
  }

  @ApiBearerAuth()
  @Get('me/saved-posts')
  @ApiOperation({ summary: 'Mis publicaciones guardadas' })
  @ApiOkResponse({ type: PostPageDto })
  saved(@CurrentUser() user: AuthUser, @Query() query: SavedPostsQueryDto): Promise<PostPageDto> {
    return this.community.saved(user.id, query);
  }

  @Public()
  @RateLimit('public')
  @Post('posts/:id/share')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Contar un compartido (devuelve el enlace)' })
  @ApiOkResponse({ type: ShareStateDto })
  share(@Param('id', uuid) id: string): Promise<ShareStateDto> {
    return this.community.share(id);
  }

  @ApiBearerAuth()
  @Put('posts/:id/attendance')
  @ApiOperation({ summary: 'Asistencia a un evento: INTERESTED, GOING o NONE (respeta el cupo)' })
  @ApiOkResponse({ type: AttendanceStateDto })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'EVENT_FULL: sin cupos o terminado.',
  })
  attendance(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: AttendanceDto,
  ): Promise<AttendanceStateDto> {
    return this.community.attendance(user.id, id, dto);
  }

  // ───────────── Comentarios ─────────────

  @Public()
  @RateLimit('public')
  @Get('posts/:id/comments')
  @ApiOperation({
    summary: 'Comentarios (primer nivel, fijados primero) o respuestas de uno (parentId)',
  })
  @ApiOkResponse({ type: CommentPageDto })
  comments(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
    @Query() query: CommentsQueryDto,
  ): Promise<CommentPageDto> {
    return this.community.comments(user?.id, id, query);
  }

  @ApiBearerAuth()
  @Post('posts/:id/comments')
  @ApiOperation({
    summary: 'Comentar o responder (máximo 2 niveles)',
    description: 'Para responder a una respuesta: el mismo parentId y mentionUserId.',
  })
  @ApiCreatedResponse({ type: CommentDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'COMMENTS_DISABLED' })
  comment(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateCommentDto,
  ): Promise<CommentDto> {
    return this.community.comment(user.id, id, dto);
  }

  @ApiBearerAuth()
  @Patch('comments/:id')
  @ApiOperation({ summary: 'Editar mi comentario' })
  @ApiOkResponse({ type: CommentDto })
  updateComment(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateCommentDto,
  ): Promise<CommentDto> {
    return this.community.updateComment(user.id, id, dto);
  }

  @ApiBearerAuth()
  @Delete('comments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borrar un comentario (su autor o el autor de la publicación)' })
  @ApiNoContentResponse()
  removeComment(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    return this.community.removeComment(user.id, id);
  }

  @ApiBearerAuth()
  @Put('comments/:id/pin')
  @ApiOperation({ summary: 'Fijar un comentario (autor de la publicación)' })
  @ApiOkResponse({ type: CommentDto })
  pinComment(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: PinCommentDto,
  ): Promise<CommentDto> {
    return this.community.pinComment(user.id, id, dto.pinned);
  }

  @ApiBearerAuth()
  @Put('comments/:id/like')
  @ApiOperation({ summary: 'Me gusta en un comentario (idempotente)' })
  @ApiOkResponse({ type: LikeStateDto })
  likeComment(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<LikeStateDto> {
    return this.community.likeComment(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('comments/:id/like')
  @ApiOperation({ summary: 'Quitar me gusta de un comentario (idempotente)' })
  @ApiOkResponse({ type: LikeStateDto })
  unlikeComment(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<LikeStateDto> {
    return this.community.likeComment(user.id, id, false);
  }

  @ApiBearerAuth()
  @Put('reviews/:id/like')
  @ApiOperation({ summary: 'Me gusta en una valoración (idempotente)' })
  @ApiOkResponse({ type: LikeStateDto })
  likeReview(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<LikeStateDto> {
    return this.community.likeReview(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('reviews/:id/like')
  @ApiOperation({ summary: 'Quitar me gusta de una valoración (idempotente)' })
  @ApiOkResponse({ type: LikeStateDto })
  unlikeReview(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<LikeStateDto> {
    return this.community.likeReview(user.id, id, false);
  }

  // ───────────── Seguir ─────────────

  @Public()
  @RateLimit('public')
  @Get('barbershops/:id/follow')
  @ApiOperation({ summary: 'Seguidores de la barbería (y si la sigo)' })
  @ApiOkResponse({ type: FollowStateDto })
  shopFollowState(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
  ): Promise<FollowStateDto> {
    return this.community.followState(user?.id, { barbershopId: id });
  }

  @ApiBearerAuth()
  @Put('barbershops/:id/follow')
  @ApiOperation({ summary: 'Seguir una barbería (idempotente)' })
  @ApiOkResponse({ type: FollowStateDto })
  followShop(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<FollowStateDto> {
    return this.community.followBarbershop(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('barbershops/:id/follow')
  @ApiOperation({ summary: 'Dejar de seguir una barbería (idempotente)' })
  @ApiOkResponse({ type: FollowStateDto })
  unfollowShop(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<FollowStateDto> {
    return this.community.followBarbershop(user.id, id, false);
  }

  @Public()
  @RateLimit('public')
  @Get('professional-profiles/:id/follow')
  @ApiOperation({ summary: 'Seguidores del perfil profesional (y si lo sigo)' })
  @ApiOkResponse({ type: FollowStateDto })
  profileFollowState(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
  ): Promise<FollowStateDto> {
    return this.community.followState(user?.id, { barberProfileId: id });
  }

  @ApiBearerAuth()
  @Put('professional-profiles/:id/follow')
  @ApiOperation({ summary: 'Seguir un perfil profesional (idempotente)' })
  @ApiOkResponse({ type: FollowStateDto })
  followProfile(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<FollowStateDto> {
    return this.community.followProfile(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('professional-profiles/:id/follow')
  @ApiOperation({ summary: 'Dejar de seguir un perfil profesional (idempotente)' })
  @ApiOkResponse({ type: FollowStateDto })
  unfollowProfile(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<FollowStateDto> {
    return this.community.followProfile(user.id, id, false);
  }

  // ───────────── Bloqueos ─────────────

  @ApiBearerAuth()
  @Put('users/:id/block')
  @ApiOperation({
    summary: 'Bloquear una cuenta: se oculta su contenido en todo, en ambos sentidos',
  })
  @ApiOkResponse({ type: BlockStateDto })
  block(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<BlockStateDto> {
    return this.community.block(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('users/:id/block')
  @ApiOperation({ summary: 'Desbloquear (idempotente)' })
  @ApiOkResponse({ type: BlockStateDto })
  unblock(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<BlockStateDto> {
    return this.community.block(user.id, id, false);
  }

  @ApiBearerAuth()
  @Get('me/blocks')
  @ApiOperation({ summary: 'Cuentas que bloqueé' })
  @ApiOkResponse({ type: [BlockedUserDto] })
  blocks(@CurrentUser() user: AuthUser): Promise<BlockedUserDto[]> {
    return this.community.blocks(user.id);
  }
}

@ApiTags('community')
@ApiBearerAuth()
@Controller('reports')
export class ContentReportsController {
  constructor(private readonly moderation: CommunityModerationService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reportar una publicación, un comentario o una cuenta',
    description:
      'Idempotente. Con N reportes de personas distintas el contenido se oculta hasta revisarlo.',
  })
  @ApiAcceptedResponse()
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  report(@CurrentUser() user: AuthUser, @Body() dto: CreateContentReportDto): Promise<void> {
    return this.moderation.report(user.id, dto);
  }
}

/** Página pública para compartir (vista previa en WhatsApp, Facebook…). */
@Controller('p')
export class SharePageController {
  constructor(private readonly community: CommunityService) {}

  @Public()
  @RateLimit('public')
  @Get(':id')
  @ApiExcludeEndpoint()
  async page(@Param('id', uuid) id: string, @Res() res: Response): Promise<void> {
    let post;
    try {
      post = await this.community.one(null, id);
    } catch {
      sendPage(
        res,
        messagePage(
          404,
          'Publicación no disponible',
          'Esta publicación ya no está disponible en Charles.',
        ),
      );
      return;
    }
    const title = `${post.author.name} en Charles`;
    const text = post.body.length > 200 ? `${post.body.slice(0, 197)}…` : post.body;
    const image = post.media[0]?.url ?? post.author.photoUrl;
    const head = [
      `<meta property="og:type" content="article">`,
      `<meta property="og:title" content="${escapeHtml(title)}">`,
      `<meta property="og:description" content="${escapeHtml(text)}">`,
      `<meta property="og:url" content="${escapeHtml(post.shareUrl)}">`,
      image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    ].join('\n');
    const body = [
      `<h1>${escapeHtml(post.author.name)}</h1>`,
      image
        ? `<p><img src="${escapeHtml(image)}" alt="" style="max-width:100%;border-radius:8px"></p>`
        : '',
      `<p>${escapeHtml(post.body).replace(/\n/g, '<br>')}</p>`,
      `<p>❤ ${post.counts.likes} · 💬 ${post.counts.comments}</p>`,
      `<p>Abre la app de Charles para ver más y reservar.</p>`,
    ].join('\n');
    sendPage(res, {
      status: 200,
      csp: `${BASE_CSP}; img-src https: http: data:`,
      html: htmlPage(title, body, head),
    });
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin/community/reports')
export class CommunityAdminController {
  constructor(private readonly moderation: CommunityModerationService) {}

  @Get()
  @ApiOperation({ summary: 'ADMIN o SUPPORT: reportes de la comunidad (los 200 más recientes)' })
  @ApiOkResponse({ type: [AdminContentReportDto] })
  list(@Query() query: AdminReportsQueryDto): Promise<AdminContentReportDto[]> {
    return this.moderation.list(query);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'ADMIN o SUPPORT: descartar, retirar o restaurar (todos los reportes del mismo contenido)',
  })
  @ApiOkResponse({ type: AdminContentReportDto })
  resolve(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ResolveReportDto,
  ): Promise<AdminContentReportDto> {
    return this.moderation.resolve(staff, id, dto);
  }
}
