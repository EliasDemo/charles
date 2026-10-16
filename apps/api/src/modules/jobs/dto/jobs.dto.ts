import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { StyleRefDto } from '../../barbers/dto/barber.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const CURSOR = /^[A-Za-z0-9_-]+$/;

export const EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'WEEKENDS',
  'COMMISSION',
  'FREELANCE',
] as const;
export const APPLICATION_DECISIONS = ['SHORTLISTED', 'REJECTED', 'HIRED'] as const;

export class CreateJobPostingDto {
  @ApiProperty({ minLength: 5, maxLength: 80, example: 'Barbero con experiencia en degradados' })
  @Transform(trim)
  @IsString()
  @Length(5, 80)
  title!: string;

  @ApiProperty({ minLength: 20, maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @Length(20, 2000)
  description!: string;

  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  @IsIn(EMPLOYMENT_TYPES)
  employmentType!: (typeof EMPLOYMENT_TYPES)[number];

  @ApiPropertyOptional({ maxLength: 120, example: '50 % por servicio' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  compensationText?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 10, description: 'Especialidades buscadas.' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  styleIds?: string[];

  @ApiPropertyOptional({ description: 'Cierre automático (opcional, máximo 90 días).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  closesAt?: Date;
}

export class UpdateJobPostingDto {
  @ApiPropertyOptional({ minLength: 5, maxLength: 80 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(5, 80)
  title?: string;

  @ApiPropertyOptional({ minLength: 20, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(20, 2000)
  description?: string;

  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: (typeof EMPLOYMENT_TYPES)[number];

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  compensationText?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  styleIds?: string[];

  @ApiPropertyOptional({ type: Date, nullable: true })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Type(() => Date)
  @IsDate()
  closesAt?: Date | null;

  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED'], description: 'Cerrar o reabrir la oferta.' })
  @IsOptional()
  @IsIn(['OPEN', 'CLOSED'])
  status?: 'OPEN' | 'CLOSED';
}

export class JobsQueryDto {
  @ApiPropertyOptional({ description: 'Clave de estilo buscado.' })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  style?: string;

  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employmentType?: (typeof EMPLOYMENT_TYPES)[number];

  @ApiPropertyOptional({ description: 'Texto en la dirección de la barbería (distrito, ciudad).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  area?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(CURSOR)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class ApplyDto {
  @ApiPropertyOptional({ maxLength: 1000, description: 'Presentación para la barbería.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  message?: string;
}

export class DecideApplicationDto {
  @ApiProperty({
    enum: APPLICATION_DECISIONS,
    description: 'HIRED crea el vínculo del barbero en la barbería (luego asígnale servicios).',
  })
  @IsIn(APPLICATION_DECISIONS)
  status!: (typeof APPLICATION_DECISIONS)[number];
}

export class InviteProfileDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  barberProfileId!: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Mensaje que llega a su bandeja.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  message?: string;
}

export class JobBarbershopDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  address!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  ratingAverage!: number | null;
}

export class JobPostingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: JobBarbershopDto })
  barbershop!: JobBarbershopDto;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  employmentType!: string;

  @ApiProperty({ type: String, nullable: true })
  compensationText!: string | null;

  @ApiProperty({ type: [StyleRefDto] })
  styles!: StyleRefDto[];

  @ApiProperty({ enum: ['OPEN', 'CLOSED'], description: 'CLOSED también si pasó closesAt.' })
  status!: 'OPEN' | 'CLOSED';

  @ApiProperty({ type: Date, nullable: true })
  closesAt!: Date | null;

  @ApiProperty({
    description: 'Postulaciones activas (solo en la vista de la barbería; 0 en la pública).',
  })
  applicationsCount!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['APPLIED', 'SHORTLISTED', 'REJECTED', 'HIRED', 'WITHDRAWN'],
    description: 'Mi postulación a esta oferta (si soy barbero y postulé).',
  })
  myApplicationStatus!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class JobPostingPageDto {
  @ApiProperty({ type: [JobPostingDto] })
  items!: JobPostingDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

export class ApplicantDto {
  @ApiProperty({ format: 'uuid' })
  barberProfileId!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ type: String, nullable: true })
  photoUrl!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  ratingAverage!: number | null;

  @ApiProperty()
  ratingCount!: number;

  @ApiProperty({ type: Number, nullable: true })
  yearsExperience!: number | null;
}

export class JobApplicationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  postingId!: string;

  @ApiProperty()
  postingTitle!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ type: ApplicantDto })
  applicant!: ApplicantDto;

  @ApiProperty({ type: String, nullable: true })
  message!: string | null;

  @ApiProperty({ enum: ['APPLIED', 'SHORTLISTED', 'REJECTED', 'HIRED', 'WITHDRAWN'] })
  status!: string;

  @ApiProperty({ type: Date, nullable: true })
  decidedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}
