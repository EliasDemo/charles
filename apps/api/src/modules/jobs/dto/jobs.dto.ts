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
  IsLatitude,
  IsLongitude,
  IsBoolean,
} from 'class-validator';
import { StyleRefDto } from '../../barbers/dto/barber.dto';
import { LocationDto } from '../../locations/locations';

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

// ───────────── Condiciones de la oferta (pedido de la app) ─────────────

export const PAY_TYPES = ['FIXED', 'COMMISSION', 'MIXED', 'PER_SERVICE'] as const;
export const PAY_PERIODS = ['DAY', 'WEEK', 'BIWEEKLY', 'MONTH', 'PER_SERVICE'] as const;
export const SELECTION_PROCESSES = ['INTERVIEW', 'TRIAL', 'DIRECT'] as const;

/** Pago, distrito, requisitos, proceso y horario: comunes a la oferta pública y a la directa. */
export class JobTermsDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Pago mínimo (céntimos).',
    example: 120000,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  payMin?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Pago máximo (céntimos).',
    example: 200000,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  payMax?: number | null;

  @ApiPropertyOptional({
    enum: PAY_TYPES,
    nullable: true,
    description: 'Fijo, comisión, mixto o por servicio.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(PAY_TYPES)
  payType?: (typeof PAY_TYPES)[number] | null;

  @ApiPropertyOptional({ enum: PAY_PERIODS, nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(PAY_PERIODS)
  payPeriod?: (typeof PAY_PERIODS)[number] | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 200,
    example: 'Lunes a sábado de 9:00 a 20:00',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  schedule?: string | null;
}

export class JobPostingTermsDto extends JobTermsDto {
  @ApiPropertyOptional({ description: 'El pago es negociable.' })
  @IsOptional()
  @IsBoolean()
  negotiable?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '211101',
    description: 'Distrito (UBIGEO). Por defecto, el de la barbería.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Matches(/^[0-9]{6}$/)
  ubigeo?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'Requisitos (hasta 20).',
    example: ['2 años de experiencia', 'Manejo de fades'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(2, 120, { each: true })
  requirements?: string[];

  @ApiPropertyOptional({
    enum: SELECTION_PROCESSES,
    nullable: true,
    description: 'Entrevista, prueba práctica o contratación directa.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(SELECTION_PROCESSES)
  selectionProcess?: (typeof SELECTION_PROCESSES)[number] | null;
}

// ───────────── Oferta directa a un barbero ─────────────

export const JOB_OFFER_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
] as const;

export class CreateJobOfferDto extends JobTermsDto {
  @ApiProperty({ format: 'uuid', description: 'Perfil profesional del barbero.' })
  @IsUUID()
  barberProfileId!: string;

  @ApiProperty({ example: 'Barbero para el turno tarde' })
  @Transform(trim)
  @IsString()
  @Length(3, 100)
  title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  message?: string;

  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  @IsIn(EMPLOYMENT_TYPES)
  employmentType!: (typeof EMPLOYMENT_TYPES)[number];

  @ApiPropertyOptional({ minimum: 1, maximum: 30, default: 7, description: 'Días para responder.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number;
}

export class AnswerJobOfferDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 300)
  note?: string;
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

export class JobOfferDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: JobBarbershopDto })
  barbershop!: JobBarbershopDto;

  @ApiProperty({ format: 'uuid' })
  barberProfileId!: string;

  @ApiProperty()
  barberName!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  message!: string | null;

  @ApiProperty({ enum: EMPLOYMENT_TYPES })
  employmentType!: string;

  @ApiProperty({ type: Number, nullable: true })
  payMin!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  payMax!: number | null;

  @ApiProperty({ enum: PAY_TYPES, nullable: true })
  payType!: string | null;

  @ApiProperty({ enum: PAY_PERIODS, nullable: true })
  payPeriod!: string | null;

  @ApiProperty({ type: String, nullable: true })
  schedule!: string | null;

  @ApiProperty({ enum: JOB_OFFER_STATUSES })
  status!: (typeof JOB_OFFER_STATUSES)[number];

  @ApiProperty()
  expiresAt!: Date;

  @ApiProperty({ type: Date, nullable: true })
  respondedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  responseNote!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class CreateJobPostingDto extends JobPostingTermsDto {
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

export class UpdateJobPostingDto extends JobPostingTermsDto {
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

  @ApiPropertyOptional({ example: '211101', description: 'Distrito (UBIGEO) de la oferta.' })
  @IsOptional()
  @Matches(/^[0-9]{6}$/)
  ubigeo?: string;

  @ApiPropertyOptional({ example: 'San Roman', description: 'Provincia (lista fija).' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  province?: string;

  @ApiPropertyOptional({ description: 'Con lng: ofertas cerca de este punto (y su distancia).' })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  radiusKm?: number;

  @ApiPropertyOptional({
    enum: ['recent', 'distance'],
    default: 'recent',
    description: 'distance: la más cercana primero (requiere lat y lng; sin paginación, hasta 50).',
  })
  @IsOptional()
  @IsIn(['recent', 'distance'])
  sort?: 'recent' | 'distance';

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

  @ApiProperty({ type: Number, nullable: true })
  payMin!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  payMax!: number | null;

  @ApiProperty({ enum: PAY_TYPES, nullable: true })
  payType!: string | null;

  @ApiProperty({ enum: PAY_PERIODS, nullable: true })
  payPeriod!: string | null;

  @ApiProperty()
  negotiable!: boolean;

  @ApiProperty({ type: LocationDto, nullable: true })
  location!: LocationDto | null;

  @ApiProperty({ type: [String] })
  requirements!: string[];

  @ApiProperty({ enum: SELECTION_PROCESSES, nullable: true })
  selectionProcess!: string | null;

  @ApiProperty({ type: String, nullable: true })
  schedule!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Km desde el punto pedido (lat/lng).' })
  distanceKm!: number | null;

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
