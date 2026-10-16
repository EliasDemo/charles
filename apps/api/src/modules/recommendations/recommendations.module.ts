import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { AuditService } from '../../common/audit/audit.service';
import { type AuthUser, OptionalUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import { AdminAccessGuard, AdminOnly, CurrentStaff, type StaffActor } from '../admin/admin-access';
import { AdminAccessModule } from '../admin/admin-access.module';
import { ImageStorageModule } from '../images/image-storage.module';
import { SettingsModule } from '../settings/settings.module';
import {
  FaceMeasurementsDto,
  FaceShapeResultDto,
  HaircutRecommendationDto,
  RecommendHaircutsDto,
} from './dto/recommendation.dto';
import { FACE_SHAPES, type FaceShape } from './face-shape';
import { RecommendationsService } from './recommendations.service';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Recomendación por forma de cara (sin sesión; con sesión usa la forma guardada si la hay). */
@ApiTags('recommendations')
@Public()
@RateLimit('public')
@Controller()
export class RecommendationsController {
  constructor(
    private readonly recommendations: RecommendationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('face-shape/classify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clasificar la forma de cara a partir de 4 medidas (nunca la foto)',
    description:
      'La app mide la cara en el teléfono y envía solo estas proporciones. No se guarda nada. ' +
      'Devuelve la forma, la confianza y las alternativas (caras mixtas).',
  })
  @ApiOkResponse({ type: FaceShapeResultDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  classify(@Body() dto: FaceMeasurementsDto): FaceShapeResultDto {
    return this.recommendations.classify(dto);
  }

  @Post('recommendations/haircuts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cortes recomendados para la forma de cara, con fotos y barberos cercanos',
    description:
      'Envía `faceShape` o `measurements` (si no, se usa la forma guardada de la cuenta). ' +
      'Nada se guarda. Muestra siempre `disclaimer`.',
  })
  @ApiOkResponse({ type: HaircutRecommendationDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  async recommend(
    @OptionalUser() user: AuthUser | null,
    @Body() dto: RecommendHaircutsDto,
  ): Promise<HaircutRecommendationDto> {
    const saved =
      user && !dto.faceShape && !dto.measurements
        ? ((
            await this.prisma.user.findUnique({
              where: { id: user.id },
              select: { faceShape: true },
            })
          )?.faceShape ?? null)
        : null;
    return this.recommendations.recommend(dto, saved);
  }
}

// ───────────── ADMIN: reglas forma ↔ corte ─────────────

export class FaceShapeRuleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: FACE_SHAPES, enumName: 'FaceShape' })
  faceShape!: FaceShape;

  @ApiProperty({ format: 'uuid' })
  styleId!: string;

  @ApiProperty()
  styleKey!: string;

  @ApiProperty()
  styleName!: string;

  @ApiProperty({ minimum: 0, maximum: 100 })
  score!: number;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ description: 'false: criterio general, aún no validado por barberos.' })
  validated!: boolean;

  @ApiProperty()
  updatedAt!: Date;
}

export class UpsertFaceShapeRuleDto {
  @ApiProperty({ enum: FACE_SHAPES, enumName: 'FaceShape' })
  @IsIn(FACE_SHAPES)
  faceShape!: FaceShape;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  styleId!: string;

  @ApiProperty({ minimum: 0, maximum: 100 })
  @IsInt()
  @Min(0)
  @Max(100)
  score!: number;

  @ApiPropertyOptional({ maxLength: 200, description: 'Por qué (se muestra al cliente).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  note?: string;

  @ApiPropertyOptional({ description: 'true: revisada con barberos o con evidencia.' })
  @IsOptional()
  @IsBoolean()
  validated?: boolean;

  @ApiProperty({ minLength: 5, maxLength: 300, description: 'Motivo del cambio (auditoría).' })
  @Transform(trim)
  @IsString()
  @Length(5, 300)
  reason!: string;
}

@ApiTags('admin')
@ApiBearerAuth()
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin/face-shape-rules')
export class FaceShapeRulesAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Solo ADMIN: matriz de compatibilidad forma de cara ↔ corte' })
  @ApiOkResponse({ type: [FaceShapeRuleDto] })
  async list(): Promise<FaceShapeRuleDto[]> {
    const rows = await this.prisma.faceShapeRule.findMany({
      include: { style: { select: { key: true, name: true, sortOrder: true } } },
      orderBy: [{ style: { sortOrder: 'asc' } }, { faceShape: 'asc' }],
    });
    return rows.map((r) => toDto(r));
  }

  @Put()
  @ApiOperation({
    summary: 'Solo ADMIN: crear o cambiar una regla (con motivo, queda en la auditoría)',
  })
  @ApiOkResponse({ type: FaceShapeRuleDto })
  async upsert(
    @CurrentStaff() staff: StaffActor,
    @Body() dto: UpsertFaceShapeRuleDto,
  ): Promise<FaceShapeRuleDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const before = await tx.faceShapeRule.findUnique({
        where: { faceShape_styleId: { faceShape: dto.faceShape, styleId: dto.styleId } },
      });
      const saved = await tx.faceShapeRule.upsert({
        where: { faceShape_styleId: { faceShape: dto.faceShape, styleId: dto.styleId } },
        update: {
          score: dto.score,
          ...(dto.note !== undefined ? { note: dto.note } : {}),
          ...(dto.validated !== undefined ? { validated: dto.validated } : {}),
        },
        create: {
          faceShape: dto.faceShape,
          styleId: dto.styleId,
          score: dto.score,
          note: dto.note ?? null,
          validated: dto.validated ?? false,
        },
        include: { style: { select: { key: true, name: true, sortOrder: true } } },
      });
      await this.audit.record(
        {
          actorId: staff.id,
          action: 'face_shape_rule.updated',
          entityType: 'face_shape_rule',
          entityId: saved.id,
          changes: {
            reason: dto.reason,
            score: { from: before?.score ?? null, to: saved.score },
            validated: { from: before?.validated ?? null, to: saved.validated },
          },
        },
        tx,
      );
      return saved;
    });
    return toDto(row);
  }
}

function toDto(r: {
  id: string;
  faceShape: FaceShape;
  styleId: string;
  score: number;
  note: string | null;
  validated: boolean;
  updatedAt: Date;
  style: { key: string; name: string };
}): FaceShapeRuleDto {
  return {
    id: r.id,
    faceShape: r.faceShape,
    styleId: r.styleId,
    styleKey: r.style.key,
    styleName: r.style.name,
    score: r.score,
    note: r.note,
    validated: r.validated,
    updatedAt: r.updatedAt,
  };
}

@Module({
  imports: [SettingsModule, ImageStorageModule, AdminAccessModule],
  controllers: [RecommendationsController, FaceShapeRulesAdminController],
  providers: [RecommendationsService],
})
export class RecommendationsModule {}
