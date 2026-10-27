import { Controller, Get, Inject, Injectable, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { Prisma } from '../../generated/prisma/client';
import { IMAGE_STORAGE, type ImageStorage } from '../images/image-storage';
import { UsersService } from '../users/users.service';
import { AdminAccessGuard, AdminOnly, SupportOrAdmin } from './admin-access';

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Colas de BullMQ de la aplicación (prefijo `charles:bull`). */
const QUEUES = [
  'outbox',
  'notifications',
  'payments',
  'bookings',
  'billing',
  'memberships',
  'reviews',
  'support',
  'account',
  'auth-mail',
  'barbershop-invitations',
  'shop',
];

// ───────────── DTOs ─────────────

export class AdminSearchQueryDto {
  @ApiProperty({
    minLength: 2,
    maxLength: 100,
    description: 'Nombre, usuario, correo exacto, barbería o código de reserva.',
  })
  @Transform(trim)
  @IsString()
  @Length(2, 100)
  q!: string;
}

export class SearchUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() username!: string;
  @ApiProperty() email!: string;
  @ApiProperty() status!: string;
}

export class SearchBarbershopDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() address!: string;
  @ApiProperty() status!: string;
}

export class SearchBookingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() serviceName!: string;
  @ApiProperty() barbershopName!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'date-time' }) startAt!: Date;
}

export class AdminSearchDto {
  @ApiProperty({ type: [SearchUserDto] }) users!: SearchUserDto[];
  @ApiProperty({ type: [SearchBarbershopDto] }) barbershops!: SearchBarbershopDto[];
  @ApiProperty({ type: [SearchBookingDto] }) bookings!: SearchBookingDto[];
}

export class MetricsQueryDto {
  @ApiPropertyOptional({ minimum: 7, maximum: 180, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(180)
  days?: number;
}

export class MetricsDayDto {
  @ApiProperty({ example: '2026-10-20', description: 'Día en hora de Lima.' }) date!: string;
  @ApiProperty({ description: 'Reservas creadas.' }) bookings!: number;
  @ApiProperty({ description: 'Reservas atendidas.' }) attended!: number;
  @ApiProperty({ description: 'Cobrado en la app (céntimos).' }) revenue!: number;
  @ApiProperty({ description: 'Comisión de Charles (céntimos).' }) commission!: number;
  @ApiProperty({ description: 'Cuentas nuevas.' }) newUsers!: number;
}

export class MetricsPlanDto {
  @ApiProperty() plan!: string;
  @ApiProperty() count!: number;
}

export class MetricsDto {
  @ApiProperty() days!: number;
  @ApiProperty({ type: [MetricsDayDto] }) series!: MetricsDayDto[];
  @ApiProperty() totalBookings!: number;
  @ApiProperty() totalRevenue!: number;
  @ApiProperty() totalCommission!: number;
  @ApiProperty() newUsers!: number;
  @ApiProperty() newBarbershops!: number;
  @ApiProperty({ description: 'Barberías publicadas hoy.' }) openBarbershops!: number;
  @ApiProperty({ description: '% de reservas canceladas o no atendidas en el periodo.' })
  lossRate!: number;
  @ApiProperty({ type: [MetricsPlanDto], description: 'Suscripciones vivas por plan.' })
  plans!: MetricsPlanDto[];
}

export class HealthCheckDto {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['OK', 'WARN', 'DOWN'] }) status!: 'OK' | 'WARN' | 'DOWN';
  @ApiProperty() detail!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'Tiempo de respuesta (ms).' })
  latencyMs!: number | null;
}

export class QueueStatDto {
  @ApiProperty() name!: string;
  @ApiProperty() waiting!: number;
  @ApiProperty() active!: number;
  @ApiProperty() delayed!: number;
  @ApiProperty() failed!: number;
}

export class SystemHealthDto {
  @ApiProperty({ enum: ['OK', 'WARN', 'DOWN'] }) status!: 'OK' | 'WARN' | 'DOWN';
  @ApiProperty({ format: 'date-time' }) checkedAt!: Date;
  @ApiProperty() version!: string;
  @ApiProperty() environment!: string;
  @ApiProperty({ description: 'Segundos desde que arrancó este proceso.' }) uptimeSeconds!: number;
  @ApiProperty({ type: [HealthCheckDto] }) checks!: HealthCheckDto[];
  @ApiProperty({ type: [QueueStatDto] }) queues!: QueueStatDto[];
}

export class AuditQueryDto {
  @ApiPropertyOptional({
    description: 'Acción (contiene), p. ej. "refund" o "subscription.canceled".',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  action?: string;

  @ApiPropertyOptional({ description: 'Usuario (nombre de usuario) de quien actuó.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  actor?: string;

  @ApiPropertyOptional({ description: 'Tipo de entidad: user, barbershop, booking, subscription…' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  entityId?: string;

  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() to?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'nextCursor de la página anterior.' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class AuditEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty() action!: string;
  @ApiProperty() entityType!: string;
  @ApiProperty({ type: String, nullable: true }) entityId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Usuario de quien actuó (null: el sistema).',
  })
  actor!: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Qué cambió (campos y valores no sensibles).',
  })
  changes!: unknown;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
}

export class AuditPageDto {
  @ApiProperty({ type: [AuditEntryDto] }) items!: AuditEntryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class StaffMemberDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() username!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty() status!: string;
  @ApiProperty({ description: 'Tiene activado el segundo factor.' }) mfaEnabled!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Último inicio de sesión.',
  })
  lastLoginAt!: Date | null;
  @ApiProperty({ description: 'Acciones registradas en la auditoría en los últimos 30 días.' })
  actionsLast30d!: number;
}

// ───────────── Servicio ─────────────

/** Gestión de TI del panel: búsqueda global, métricas, salud, auditoría y personal. */
@Injectable()
export class AdminInsightsService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly crypto: EncryptionService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private email(enc: string): string {
    try {
      return this.crypto.decrypt(enc, EncryptedField.USER_EMAIL);
    } catch {
      return '—';
    }
  }

  async search(q: string): Promise<AdminSearchDto> {
    const userWhere: Prisma.UserWhereInput = q.includes('@')
      ? { emailHash: this.users.emailHash(q.toLowerCase()) }
      : {
          OR: [
            { username: { contains: q.replace(/^@/, ''), mode: 'insensitive' } },
            { fullName: { contains: q, mode: 'insensitive' } },
          ],
        };
    const [users, barbershops, bookings] = await Promise.all([
      this.prisma.user.findMany({
        where: { ...userWhere, deletedAt: null },
        select: { id: true, fullName: true, username: true, emailEnc: true, status: true },
        orderBy: { createdAt: 'desc' },
        take: 6,
      }),
      this.prisma.barbershop.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { address: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, name: true, address: true, status: true },
        orderBy: { name: 'asc' },
        take: 6,
      }),
      UUID.test(q)
        ? this.prisma.booking.findMany({
            where: { id: q },
            select: {
              id: true,
              serviceNameSnapshot: true,
              status: true,
              startAt: true,
              barbershop: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    return {
      users: users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        username: u.username,
        email: this.email(u.emailEnc),
        status: u.status,
      })),
      barbershops,
      bookings: bookings.map((b) => ({
        id: b.id,
        serviceName: b.serviceNameSnapshot,
        barbershopName: b.barbershop.name,
        status: b.status,
        startAt: b.startAt,
      })),
    };
  }

  async metrics(days = 30): Promise<MetricsDto> {
    const now = this.clock.now();
    const from = new Date(now - (days - 1) * DAY_MS);
    from.setUTCHours(5, 0, 0, 0); // medianoche de Lima
    type Row = { day: string; n: number };
    const day = (col: string) =>
      Prisma.raw(`to_char(${col} AT TIME ZONE 'America/Lima', 'YYYY-MM-DD')`);
    const [bookings, attended, money, users, newShops, openShops, losses, plans] =
      await Promise.all([
        this.prisma.$queryRaw<
          Row[]
        >`SELECT ${day('created_at')} AS day, COUNT(*)::int AS n FROM bookings WHERE created_at >= ${from} GROUP BY 1`,
        this.prisma.$queryRaw<
          Row[]
        >`SELECT ${day('start_at')} AS day, COUNT(*)::int AS n FROM bookings WHERE status = 'ATTENDED' AND start_at >= ${from} GROUP BY 1`,
        this.prisma.$queryRaw<{ day: string; revenue: number; commission: number }[]>`
        SELECT ${day('p.confirmed_at')} AS day, COALESCE(SUM(p.amount), 0)::int AS revenue,
               COALESCE(SUM(b.commission_amount), 0)::int AS commission
          FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE p.confirmed_at >= ${from} AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED') GROUP BY 1`,
        this.prisma.$queryRaw<
          Row[]
        >`SELECT ${day('created_at')} AS day, COUNT(*)::int AS n FROM users WHERE created_at >= ${from} GROUP BY 1`,
        this.prisma.barbershop.count({ where: { createdAt: { gte: from }, deletedAt: null } }),
        this.prisma.barbershop.count({ where: { status: 'OPEN', deletedAt: null } }),
        this.prisma.booking.groupBy({
          by: ['status'],
          where: { startAt: { gte: from, lte: new Date(now) } },
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<{ plan: string; count: number }[]>`
        SELECT p.name AS plan, COUNT(*)::int AS count FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.status IN ('TRIALING', 'ACTIVE', 'PAST_DUE') GROUP BY p.name ORDER BY count DESC`,
      ]);
    const map = (rows: Row[]) => new Map(rows.map((r) => [r.day, r.n]));
    const b = map(bookings);
    const a = map(attended);
    const u = map(users);
    const m = new Map(money.map((r) => [r.day, r]));
    const series: MetricsDayDto[] = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(from.getTime() + i * DAY_MS - 5 * 3_600_000).toISOString().slice(0, 10);
      series.push({
        date,
        bookings: b.get(date) ?? 0,
        attended: a.get(date) ?? 0,
        revenue: m.get(date)?.revenue ?? 0,
        commission: m.get(date)?.commission ?? 0,
        newUsers: u.get(date) ?? 0,
      });
    }
    const total = losses.reduce((s, r) => s + r._count._all, 0);
    const lost = losses
      .filter((r) => r.status === 'CANCELLED' || r.status === 'NO_SHOW')
      .reduce((s, r) => s + r._count._all, 0);
    return {
      days,
      series,
      totalBookings: series.reduce((s, d) => s + d.bookings, 0),
      totalRevenue: series.reduce((s, d) => s + d.revenue, 0),
      totalCommission: series.reduce((s, d) => s + d.commission, 0),
      newUsers: series.reduce((s, d) => s + d.newUsers, 0),
      newBarbershops: newShops,
      openBarbershops: openShops,
      lossRate: total ? Math.round((lost / total) * 1000) / 10 : 0,
      plans,
    };
  }

  private async timed<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T; ms: number } | { ok: false; ms: number }> {
    const t = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const value = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), 3000);
        }),
      ]);
      return { ok: true, value, ms: Math.round(performance.now() - t) };
    } catch {
      return { ok: false, ms: Math.round(performance.now() - t) };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<SystemHealthDto> {
    const now = this.clock.now();
    const checks: HealthCheckDto[] = [];
    const db = await this.timed(() => this.prisma.$queryRaw`SELECT 1`);
    checks.push({
      name: 'Base de datos',
      status: db.ok ? (db.ms > 500 ? 'WARN' : 'OK') : 'DOWN',
      detail: db.ok ? 'PostgreSQL responde' : 'Sin conexión',
      latencyMs: db.ms,
    });
    const redis = await this.timed(() => this.redis.ping());
    checks.push({
      name: 'Redis (colas y caché)',
      status: redis.ok ? (redis.ms > 300 ? 'WARN' : 'OK') : 'DOWN',
      detail: redis.ok ? 'Responde' : 'Sin conexión',
      latencyMs: redis.ms,
    });
    checks.push({
      name: 'Almacenamiento de fotos',
      status: this.storage.enabled ? 'OK' : 'WARN',
      detail: this.storage.enabled ? 'Configurado' : 'Sin configurar: no se pueden subir fotos',
      latencyMs: null,
    });

    const stale = new Date(now - 10 * 60_000);
    const [
      outboxPending,
      outboxStale,
      outboxFailed,
      notifFailed,
      notifStale,
      paymentsStale,
      refundsFailed,
    ] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
      this.prisma.outboxEvent.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: stale } },
      }),
      this.prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
      this.prisma.notification.count({
        where: { status: 'FAILED', createdAt: { gte: new Date(now - DAY_MS) } },
      }),
      this.prisma.notification.count({ where: { status: 'PENDING', sendAfter: { lt: stale } } }),
      this.prisma.payment.count({
        where: { status: 'PENDING', startedAt: { lt: new Date(now - 30 * 60_000) } },
      }),
      this.prisma.refund.count({ where: { status: 'FAILED' } }),
    ]);
    checks.push({
      name: 'Eventos internos (outbox)',
      status: outboxFailed > 0 || outboxStale > 0 ? 'WARN' : 'OK',
      detail: `${outboxPending} pendientes · ${outboxStale} atrasados (+10 min) · ${outboxFailed} fallidos`,
      latencyMs: null,
    });
    checks.push({
      name: 'Notificaciones',
      status: notifStale > 20 || notifFailed > 20 ? 'WARN' : 'OK',
      detail: `${notifStale} atrasadas · ${notifFailed} fallidas en 24 h`,
      latencyMs: null,
    });
    checks.push({
      name: 'Pagos y reembolsos',
      status: paymentsStale > 0 || refundsFailed > 0 ? 'WARN' : 'OK',
      detail: `${paymentsStale} pagos sin confirmar (+30 min) · ${refundsFailed} reembolsos fallidos`,
      latencyMs: null,
    });

    const queues: QueueStatDto[] = [];
    if (redis.ok) {
      for (const name of QUEUES) {
        const k = `charles:bull:${name}`;
        const r = await this.timed(() =>
          this.redis
            .multi()
            .llen(`${k}:wait`)
            .llen(`${k}:active`)
            .zcard(`${k}:delayed`)
            .zcount(`${k}:failed`, Date.now() - 86_400_000, '+inf')
            .exec(),
        );
        if (!r.ok || !r.value) continue;
        const [w, a, d, f] = r.value.map(([, v]) => Number(v ?? 0));
        queues.push({ name, waiting: w ?? 0, active: a ?? 0, delayed: d ?? 0, failed: f ?? 0 });
      }
    }
    const failed = queues.filter((q) => q.failed > 0);
    if (redis.ok) {
      checks.push({
        name: 'Colas de trabajo',
        status: failed.length ? 'WARN' : 'OK',
        detail: failed.length
          ? `Trabajos fallidos en las últimas 24 h: ${failed.map((q) => `${q.name} (${q.failed})`).join(', ')}`
          : 'Sin trabajos fallidos en las últimas 24 h',
        latencyMs: null,
      });
    }
    const worst = checks.some((c) => c.status === 'DOWN')
      ? 'DOWN'
      : checks.some((c) => c.status === 'WARN')
        ? 'WARN'
        : 'OK';
    return {
      status: worst,
      checkedAt: new Date(now),
      version: process.env.APP_VERSION ?? process.env.npm_package_version ?? 'dev',
      environment: process.env.NODE_ENV ?? 'development',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checks,
      queues,
    };
  }

  async audit(query: AuditQueryDto): Promise<AuditPageDto> {
    const limit = query.limit ?? 50;
    let actorId: string | undefined;
    if (query.actor) {
      const actor = await this.prisma.user.findFirst({
        where: { username: query.actor.replace(/^@/, '') },
        select: { id: true },
      });
      if (!actor) return { items: [], nextCursor: null };
      actorId = actor.id;
    }
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(query.action ? { action: { contains: query.action, mode: 'insensitive' } } : {}),
        ...(actorId ? { actorId } : {}),
        ...(query.entityType ? { entityType: query.entityType } : {}),
        ...(query.entityId ? { entityId: query.entityId } : {}),
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const actors = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(page.flatMap((r) => (r.actorId ? [r.actorId] : [])))] } },
      select: { id: true, username: true },
    });
    const names = new Map(actors.map((a) => [a.id, a.username]));
    return {
      items: page.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        actor: r.actorId ? (names.get(r.actorId) ?? r.actorId) : null,
        changes: r.changes,
        ip: r.ip,
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** CSV de la auditoría con los mismos filtros (hasta 5 000 filas). */
  async auditCsv(query: AuditQueryDto): Promise<string> {
    const lines = ['fecha,usuario,accion,entidad,id_entidad,ip,cambios'];
    let cursor: string | undefined;
    for (let i = 0; i < 25; i++) {
      const page = await this.audit({ ...query, cursor, limit: 200 });
      for (const r of page.items) {
        const cells = [
          r.createdAt.toISOString(),
          r.actor ?? 'sistema',
          r.action,
          r.entityType,
          r.entityId ?? '',
          r.ip ?? '',
          r.changes ? JSON.stringify(r.changes) : '',
        ];
        lines.push(cells.map(csvCell).join(','));
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return `${lines.join('\n')}\n`;
  }

  async staff(): Promise<StaffMemberDto[]> {
    const rows = await this.prisma.user.findMany({
      where: { deletedAt: null, roles: { some: { role: { in: ['ADMIN', 'SUPPORT'] } } } },
      select: {
        id: true,
        fullName: true,
        username: true,
        emailEnc: true,
        status: true,
        roles: { select: { role: true } },
        mfa: { select: { enabledAt: true } },
      },
      orderBy: { fullName: 'asc' },
    });
    const ids = rows.map((r) => r.id);
    const [logins, actions] = await Promise.all([
      this.prisma.refreshToken.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _max: { createdAt: true },
      }),
      this.prisma.auditLog.groupBy({
        by: ['actorId'],
        // La auditoría guarda la hora de la base: la ventana se mide con la hora real.
        where: { actorId: { in: ids }, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
        _count: { _all: true },
      }),
    ]);
    const last = new Map(logins.map((l) => [l.userId, l._max.createdAt]));
    const count = new Map(actions.map((a) => [a.actorId, a._count._all]));
    return rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      username: r.username,
      email: this.email(r.emailEnc),
      roles: r.roles.map((x) => x.role).filter((x) => x === 'ADMIN' || x === 'SUPPORT'),
      status: r.status,
      mfaEnabled: !!r.mfa?.enabledAt,
      lastLoginAt: last.get(r.id) ?? null,
      actionsLast30d: count.get(r.id) ?? 0,
    }));
  }
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// ───────────── Controladores ─────────────

@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@SupportOrAdmin()
@UseGuards(AdminAccessGuard)
@Controller('admin')
export class AdminInsightsController {
  constructor(private readonly insights: AdminInsightsService) {}

  @Get('search')
  @ApiOperation({
    summary: 'ADMIN o SUPPORT: búsqueda global (cuentas, barberías y reserva por código)',
  })
  @ApiOkResponse({ type: AdminSearchDto })
  search(@Query() query: AdminSearchQueryDto): Promise<AdminSearchDto> {
    return this.insights.search(query.q);
  }

  @Get('metrics')
  @AdminOnly()
  @ApiOperation({ summary: 'Solo ADMIN: reservas, ingresos, comisiones y cuentas por día' })
  @ApiOkResponse({ type: MetricsDto })
  metrics(@Query() query: MetricsQueryDto): Promise<MetricsDto> {
    return this.insights.metrics(query.days);
  }

  @Get('system/health')
  @AdminOnly()
  @ApiOperation({
    summary: 'Solo ADMIN: salud del sistema (base, Redis, fotos, colas, pagos y avisos)',
  })
  @ApiOkResponse({ type: SystemHealthDto })
  health(): Promise<SystemHealthDto> {
    return this.insights.health();
  }

  @Get('audit')
  @AdminOnly()
  @ApiOperation({
    summary: 'Solo ADMIN: auditoría (quién hizo qué y cuándo), más recientes primero',
  })
  @ApiOkResponse({ type: AuditPageDto })
  audit(@Query() query: AuditQueryDto): Promise<AuditPageDto> {
    return this.insights.audit(query);
  }

  @Get('audit.csv')
  @AdminOnly()
  @ApiOperation({ summary: 'Solo ADMIN: auditoría en CSV (mismos filtros, hasta 5 000 filas)' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'Archivo CSV' })
  async auditCsv(@Query() query: AuditQueryDto, @Res() res: Response): Promise<void> {
    const csv = await this.insights.auditCsv(query);
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="auditoria.csv"')
      .send(`\uFEFF${csv}`);
  }

  @Get('staff')
  @AdminOnly()
  @ApiOperation({
    summary: 'Solo ADMIN: personal (ADMIN y SUPPORT), segundo factor, último acceso y actividad',
  })
  @ApiOkResponse({ type: [StaffMemberDto] })
  staff(): Promise<StaffMemberDto[]> {
    return this.insights.staff();
  }
}
