import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser, OptionalUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import {
  AdminAccessGuard,
  AdminOnly,
  CurrentStaff,
  type StaffActor,
  SupportOrAdmin,
} from '../admin/admin-access';
import { AdminAccessModule } from '../admin/admin-access.module';
import { CommunityModule } from '../community/community.module';
import { ImageStorageModule } from '../images/image-storage.module';
import {
  AdminForumCategoryDto,
  AdminThreadDto,
  AdminThreadsQueryDto,
  CreateForumCategoryDto,
  CreateReplyDto,
  CreateThreadDto,
  ForumCategoryDto,
  ModerateThreadDto,
  RepliesQueryDto,
  ReplyDto,
  ReplyPageDto,
  SolutionDto,
  ThreadDto,
  ThreadPageDto,
  ThreadsQueryDto,
  UpdateForumCategoryDto,
  UpdateReplyDto,
  UpdateThreadDto,
} from './dto/forum.dto';
import { ForumsService } from './forums.service';

const uuid = new ParseUUIDPipe();

/** Foros: preguntas y respuestas por tema. Leer es público; participar exige sesión. */
@ApiTags('forums')
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('forums')
export class ForumsController {
  constructor(private readonly forums: ForumsService) {}

  @Public()
  @RateLimit('public')
  @Get('categories')
  @ApiOperation({ summary: 'Temas del foro (activos, en su orden)' })
  @ApiOkResponse({ type: [ForumCategoryDto] })
  categories(): Promise<ForumCategoryDto[]> {
    return this.forums.categories();
  }

  @Public()
  @RateLimit('public')
  @Get('threads')
  @ApiOperation({
    summary: 'Hilos: por tema, búsqueda en el título y orden (reciente, nuevos, sin respuesta)',
    description: 'Con sesión se ocultan los de cuentas bloqueadas.',
  })
  @ApiOkResponse({ type: ThreadPageDto })
  threads(
    @OptionalUser() user: AuthUser | null,
    @Query() query: ThreadsQueryDto,
  ): Promise<ThreadPageDto> {
    return this.forums.threads(user?.id, query);
  }

  @Public()
  @RateLimit('public')
  @Get('threads/:id')
  @ApiOperation({ summary: 'Un hilo con su texto completo' })
  @ApiOkResponse({ type: ThreadDto })
  @ApiGoneResponse({ type: ErrorResponseDto, description: 'THREAD_HIDDEN' })
  thread(@OptionalUser() user: AuthUser | null, @Param('id', uuid) id: string): Promise<ThreadDto> {
    return this.forums.thread(user?.id, id);
  }

  @ApiBearerAuth()
  @Post('threads')
  @ApiOperation({
    summary: 'Abrir un hilo (pregunta o tema de conversación)',
    description: 'Mismos límites y palabras no permitidas que la Comunidad.',
  })
  @ApiCreatedResponse({ type: ThreadDto })
  createThread(@CurrentUser() user: AuthUser, @Body() dto: CreateThreadDto): Promise<ThreadDto> {
    return this.forums.createThread(user.id, dto);
  }

  @ApiBearerAuth()
  @Patch('threads/:id')
  @ApiOperation({ summary: 'Autor: editar el título o el texto' })
  @ApiOkResponse({ type: ThreadDto })
  updateThread(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateThreadDto,
  ): Promise<ThreadDto> {
    return this.forums.updateThread(user.id, id, dto);
  }

  @ApiBearerAuth()
  @Delete('threads/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Autor: borrar el hilo' })
  @ApiNoContentResponse()
  async deleteThread(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    await this.forums.deleteThread(user.id, id);
  }

  @Public()
  @RateLimit('public')
  @Get('threads/:id/replies')
  @ApiOperation({ summary: 'Respuestas (la mejor primero; luego por fecha o por "me sirvió")' })
  @ApiOkResponse({ type: ReplyPageDto })
  replies(
    @OptionalUser() user: AuthUser | null,
    @Param('id', uuid) id: string,
    @Query() query: RepliesQueryDto,
  ): Promise<ReplyPageDto> {
    return this.forums.replies(user?.id, id, query);
  }

  @ApiBearerAuth()
  @Post('threads/:id/replies')
  @ApiOperation({ summary: 'Responder (avisa a quien abrió el hilo)' })
  @ApiCreatedResponse({ type: ReplyDto })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'THREAD_LOCKED' })
  reply(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: CreateReplyDto,
  ): Promise<ReplyDto> {
    return this.forums.reply(user.id, id, dto);
  }

  @ApiBearerAuth()
  @Put('threads/:id/solution')
  @ApiOperation({
    summary: 'Autor del hilo: marcar la mejor respuesta (avisa a quien la escribió)',
  })
  @ApiOkResponse({ type: ThreadDto })
  markSolution(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: SolutionDto,
  ): Promise<ThreadDto> {
    return this.forums.markSolution(user.id, id, dto.replyId);
  }

  @ApiBearerAuth()
  @Delete('threads/:id/solution')
  @ApiOperation({ summary: 'Autor del hilo: quitar la mejor respuesta' })
  @ApiOkResponse({ type: ThreadDto })
  clearSolution(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<ThreadDto> {
    return this.forums.clearSolution(user.id, id);
  }

  @ApiBearerAuth()
  @Patch('replies/:id')
  @ApiOperation({ summary: 'Autor: editar una respuesta' })
  @ApiOkResponse({ type: ReplyDto })
  updateReply(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateReplyDto,
  ): Promise<ReplyDto> {
    return this.forums.updateReply(user.id, id, dto);
  }

  @ApiBearerAuth()
  @Delete('replies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Autor: borrar una respuesta' })
  @ApiNoContentResponse()
  async deleteReply(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<void> {
    await this.forums.deleteReply(user.id, id);
  }

  @ApiBearerAuth()
  @Put('replies/:id/helpful')
  @ApiOperation({ summary: 'Votar "me sirvió" (idempotente; no en respuestas propias)' })
  @ApiOkResponse({ type: ReplyDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  helpful(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<ReplyDto> {
    return this.forums.vote(user.id, id, true);
  }

  @ApiBearerAuth()
  @Delete('replies/:id/helpful')
  @ApiOperation({ summary: 'Quitar el voto "me sirvió"' })
  @ApiOkResponse({ type: ReplyDto })
  unhelpful(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<ReplyDto> {
    return this.forums.vote(user.id, id, false);
  }
}

/** Panel: temas (solo ADMIN) y moderación de hilos (soporte). Los reportes van por /admin/reports. */
@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin/forum')
export class ForumsAdminController {
  constructor(private readonly forums: ForumsService) {}

  @Get('categories')
  @ApiOperation({ summary: 'Temas del foro (también los inactivos)' })
  @ApiOkResponse({ type: [AdminForumCategoryDto] })
  categories(): Promise<AdminForumCategoryDto[]> {
    return this.forums.adminCategories();
  }

  @Post('categories')
  @AdminOnly()
  @ApiOperation({ summary: 'Solo ADMIN: crear un tema' })
  @ApiCreatedResponse({ type: AdminForumCategoryDto })
  createCategory(
    @CurrentStaff() staff: StaffActor,
    @Body() dto: CreateForumCategoryDto,
  ): Promise<AdminForumCategoryDto> {
    return this.forums.createCategory(staff, dto);
  }

  @Patch('categories/:id')
  @AdminOnly()
  @ApiOperation({ summary: 'Solo ADMIN: editar, ordenar o desactivar un tema' })
  @ApiOkResponse({ type: AdminForumCategoryDto })
  updateCategory(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateForumCategoryDto,
  ): Promise<AdminForumCategoryDto> {
    return this.forums.updateCategory(staff, id, dto);
  }

  @Get('threads')
  @ApiOperation({ summary: 'Hilos para moderar (reportados, ocultos, retirados o todos)' })
  @ApiOkResponse({ type: [AdminThreadDto] })
  threads(@Query() query: AdminThreadsQueryDto): Promise<AdminThreadDto[]> {
    return this.forums.adminThreads(query);
  }

  @Patch('threads/:id')
  @ApiOperation({ summary: 'Fijar, cerrar, mover de tema o retirar un hilo (auditado)' })
  @ApiOkResponse({ type: AdminThreadDto })
  moderate(
    @CurrentStaff() staff: StaffActor,
    @Param('id', uuid) id: string,
    @Body() dto: ModerateThreadDto,
  ): Promise<AdminThreadDto> {
    return this.forums.moderateThread(staff, id, dto);
  }
}

@Module({
  imports: [CommunityModule, AdminAccessModule, ImageStorageModule],
  controllers: [ForumsController, ForumsAdminController],
  providers: [ForumsService],
})
export class ForumsModule {}
