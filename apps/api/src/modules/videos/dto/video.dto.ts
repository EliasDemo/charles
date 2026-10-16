import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class VideoUploadDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'MP4, MOV o WebM; hasta 30 s y 50 MB.',
  })
  // Lo lee multer, no el cuerpo: solo se documenta (y se permite) aquí.
  @IsOptional()
  file?: unknown;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  caption?: string;
}

export class VideoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: ['PROCESSING', 'READY', 'FAILED'],
    description: 'PROCESSING mientras se comprime (segundos); vuelve a consultar.',
  })
  status!: 'PROCESSING' | 'READY' | 'FAILED';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'MP4 (H.264, máx. 720p). null si no está listo.',
  })
  videoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Miniatura WebP.' })
  posterUrl!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  durationMs!: number | null;

  @ApiProperty({ type: String, nullable: true })
  caption!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['NOT_A_VIDEO', 'TOO_LONG', 'TOO_LARGE', 'PROCESSING_FAILED'],
    description: 'Por qué falló (solo en la vista de quien lo subió).',
  })
  failureReason!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class VideoReportDto {
  @ApiProperty({ enum: ['NOT_MY_PHOTO', 'NO_CONSENT', 'INAPPROPRIATE', 'MISLEADING', 'OTHER'] })
  @IsIn(['NOT_MY_PHOTO', 'NO_CONSENT', 'INAPPROPRIATE', 'MISLEADING', 'OTHER'])
  reason!: 'NOT_MY_PHOTO' | 'NO_CONSENT' | 'INAPPROPRIATE' | 'MISLEADING' | 'OTHER';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  details?: string;
}

export class VideoModerationDto {
  @ApiProperty({ enum: ['KEEP', 'REMOVE', 'RESTORE'] })
  @IsIn(['KEEP', 'REMOVE', 'RESTORE'])
  decision!: 'KEEP' | 'REMOVE' | 'RESTORE';

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class ReportedVideoDto extends VideoDto {
  @ApiProperty({ type: String, nullable: true })
  ownerName!: string | null;

  @ApiProperty()
  openReports!: number;

  @ApiProperty()
  removed!: boolean;

  @ApiProperty({ type: [String], description: 'Motivos de los reportes abiertos.' })
  reasons!: string[];
}
