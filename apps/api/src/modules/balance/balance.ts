import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  NotEquals,
} from 'class-validator';
import { AuditService } from '../../common/audit/audit.service';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AdminAccessModule } from '../admin/admin-access.module';
import { AdminAccessGuard, AdminOnly, CurrentStaff, type StaffActor } from '../admin/admin-access';
import { BarbershopAccessModule } from '../barbershops/barbershop-access.module';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import { SettingsModule } from '../settings/settings.module';

type Tx = Prisma.TransactionClient;
const DAY_MS = 86_400_000;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ───────────── DTOs ─────────────

export class BalanceDto {
  @ApiProperty({
    description:
      'Saldo a favor disponible (céntimos): se puede liquidar o usar para pagar el plan.',
  })
  available!: number;

  @ApiProperty({
    description: 'Cobrado por Charles de reservas aún no atendidas (se libera al atender).',
  })
  pending!: number;

  @ApiProperty({
    description: 'Cobrado directo en tu cuenta de Mercado Pago (no pasa por el saldo).',
  })
  paidDirect!: number;

  @ApiProperty({ example: 'PEN' })
  currency!: string;

  @ApiProperty({ description: 'true si la barbería tiene su cuenta de Mercado Pago vinculada.' })
  sellerConnected!: boolean;
}

export const STATEMENT_KINDS = [
  'BOOKING',
  'BOOKING_DIRECT',
  'REFUND',
  'MEMBERSHIP',
  'SUBSCRIPTION_PAYMENT',
  'PAYOUT',
  'ADJUSTMENT',
] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export class StatementLineDto {
  @ApiProperty({ format: 'date-time' })
  at!: Date;

  @ApiProperty({
    enum: STATEMENT_KINDS,
    description:
      'BOOKING: reserva cobrada por Charles (suma al saldo al atenderse). BOOKING_DIRECT: cobrada en tu ' +
      'cuenta de Mercado Pago (informativa). REFUND: devolución. MEMBERSHIP: cobro de membresía. ' +
      'SUBSCRIPTION_PAYMENT: plan pagado con saldo. PAYOUT: transferencia de Charles. ADJUSTMENT: ajuste.',
  })
  kind!: StatementKind;

  @ApiProperty()
  description!: string;

  @ApiProperty({ description: 'Monto cobrado al cliente (céntimos; 0 en movimientos).' })
  gross!: number;

  @ApiProperty({ description: 'Comisión de Charles (céntimos).' })
  commission!: number;

  @ApiProperty({ description: 'Efecto en tu saldo (con signo; 0 si no lo afecta).' })
  net!: number;

  @ApiProperty({ enum: ['PLATFORM', 'SELLER', 'NONE'], description: 'Quién recibió el dinero.' })
  payee!: 'PLATFORM' | 'SELLER' | 'NONE';

  @ApiProperty({ enum: ['AVAILABLE', 'PENDING', 'INFO'] })
  state!: 'AVAILABLE' | 'PENDING' | 'INFO';

  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  bookingId!: string | null;
}

export class StatementDto {
  @ApiProperty({ type: BalanceDto })
  balance!: BalanceDto;

  @ApiProperty({ format: 'date-time' })
  from!: Date;

  @ApiProperty({ format: 'date-time' })
  to!: Date;

  @ApiProperty({ description: 'Total cobrado en el periodo (céntimos).' })
  gross!: number;

  @ApiProperty({ description: 'Comisiones de Charles en el periodo.' })
  commission!: number;

  @ApiProperty({ description: 'Neto de la barbería en el periodo.' })
  net!: number;

  @ApiProperty({
    type: [StatementLineDto],
    description: 'Del más reciente al más antiguo (máx. 500).',
  })
  lines!: StatementLineDto[];
}

export class StatementQueryDto {
  @ApiPropertyOptional({ format: 'date-time', description: 'Por defecto, hace 30 días.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Por defecto, ahora.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AdminBalanceDto extends BalanceDto {
  @ApiProperty({ format: 'uuid' })
  barbershopId!: string;

  @ApiProperty()
  barbershopName!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  lastPayoutAt!: Date | null;
}

export class CreateBalanceMovementDto {
  @ApiProperty({ enum: ['PAYOUT', 'ADJUSTMENT'] })
  @IsIn(['PAYOUT', 'ADJUSTMENT'])
  type!: 'PAYOUT' | 'ADJUSTMENT';

  @ApiProperty({
    description:
      'Céntimos. PAYOUT: monto transferido (positivo; se descuenta). ADJUSTMENT: con signo.',
  })
  @IsInt()
  @NotEquals(0)
  amount!: number;

  @ApiPropertyOptional({ maxLength: 120, description: 'N.º de operación de la transferencia.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  reference?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class BalanceMovementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['SUBSCRIPTION_PAYMENT', 'PAYOUT', 'ADJUSTMENT'] })
  type!: string;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

// ───────────── Servicio ─────────────

interface Totals {
  available: number;
  pending: number;
  paidDirect: number;
}

/**
 * Saldo a favor de la barbería y su estado de cuenta.
 *
 * - Reserva cobrada con la cuenta de Charles (`payee = PLATFORM`): al atenderse, suma al saldo el
 *   total menos la comisión y menos lo devuelto. Mientras no se atiende, es "pendiente".
 * - Reserva cobrada con la cuenta de la barbería (`SELLER`, Marketplace): el dinero ya está en su
 *   Mercado Pago; Charles retuvo la comisión. No afecta el saldo (solo se informa).
 * - Membresías: la cuota cobrada, menos la comisión general (`fees.percent_bp`).
 * - Movimientos: pago del plan con saldo, liquidaciones de Charles y ajustes (con signo).
 */
@Injectable()
export class BalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async balance(userId: string, barbershopId: string): Promise<BalanceDto> {
    await this.access.requireMember(userId, barbershopId);
    return this.balanceOf(barbershopId);
  }

  async balanceOf(barbershopId: string, tx: Tx = this.prisma): Promise<BalanceDto> {
    const [totals, seller] = await Promise.all([
      this.totals(tx, barbershopId),
      tx.sellerAccount.findUnique({ where: { barbershopId }, select: { status: true } }),
    ]);
    return { ...totals, currency: 'PEN', sellerConnected: seller?.status === 'CONNECTED' };
  }

  /**
   * Saldo disponible con la barbería bloqueada (para descontar sin carreras). Usar dentro de la
   * transacción que registra el movimiento.
   */
  async lockAvailable(tx: Tx, barbershopId: string): Promise<number> {
    await tx.$queryRaw`SELECT id FROM barbershops WHERE id = ${barbershopId}::uuid FOR UPDATE`;
    return (await this.totals(tx, barbershopId)).available;
  }

  private async membershipFeeBp(): Promise<number> {
    return this.settings.nonNegativeInt(SettingKey.FEES_PERCENT_BP, 0);
  }

  private async totals(tx: Tx, barbershopId: string): Promise<Totals> {
    const feeBp = await this.membershipFeeBp();
    const [bookings] = await tx.$queryRaw<{ available: bigint; pending: bigint; direct: bigint }[]>`
      SELECT
        COALESCE(SUM(CASE WHEN p.payee = 'PLATFORM' AND b.status = 'ATTENDED'
                          THEN p.amount - b.commission_amount - COALESCE(r.refunded, 0) END), 0)::bigint AS available,
        COALESCE(SUM(CASE WHEN p.payee = 'PLATFORM' AND b.status = 'CONFIRMED'
                          THEN p.amount - b.commission_amount - COALESCE(r.refunded, 0) END), 0)::bigint AS pending,
        COALESCE(SUM(CASE WHEN p.payee = 'SELLER'
                          THEN p.amount - COALESCE(p.marketplace_fee, 0) - COALESCE(r.refunded, 0) END), 0)::bigint AS direct
        FROM payments p
        JOIN bookings b ON b.id = p.booking_id
        LEFT JOIN (SELECT payment_id, SUM(amount) AS refunded FROM refunds
                    WHERE status = 'SUCCEEDED' GROUP BY payment_id) r ON r.payment_id = p.id
       WHERE b.barbershop_id = ${barbershopId}::uuid
         AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')`;
    const [memberships] = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(c.amount), 0)::bigint AS total
        FROM billing_charges c JOIN memberships m ON m.id = c.membership_id
       WHERE m.barbershop_id = ${barbershopId}::uuid AND c.status = 'PAID'`;
    const movements = await tx.balanceMovement.aggregate({
      where: { barbershopId },
      _sum: { amount: true },
    });
    const membershipGross = Number(memberships?.total ?? 0);
    const membershipNet = membershipGross - Math.round((membershipGross * feeBp) / 10_000);
    return {
      available: Number(bookings?.available ?? 0) + membershipNet + (movements._sum.amount ?? 0),
      pending: Number(bookings?.pending ?? 0),
      paidDirect: Number(bookings?.direct ?? 0),
    };
  }

  /** Estado de cuenta del periodo (máx. 366 días). */
  async statement(
    userId: string,
    barbershopId: string,
    query: StatementQueryDto,
  ): Promise<StatementDto> {
    await this.access.requireMember(userId, barbershopId);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
    if (from > to || to.getTime() - from.getTime() > 366 * DAY_MS) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'El periodo debe ser de hasta un año.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'from', constraints: ['range'] }],
      );
    }
    const feeBp = await this.membershipFeeBp();
    const [payments, refunds, charges, movements, balance] = await Promise.all([
      this.prisma.payment.findMany({
        where: {
          booking: { barbershopId },
          status: { in: ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
          confirmedAt: { gte: from, lte: to },
        },
        select: {
          amount: true,
          payee: true,
          marketplaceFee: true,
          confirmedAt: true,
          booking: {
            select: {
              id: true,
              status: true,
              commissionAmount: true,
              serviceNameSnapshot: true,
              startAt: true,
            },
          },
        },
        orderBy: { confirmedAt: 'desc' },
        take: 500,
      }),
      this.prisma.refund.findMany({
        where: {
          status: 'SUCCEEDED',
          processedAt: { gte: from, lte: to },
          payment: { booking: { barbershopId } },
        },
        select: {
          amount: true,
          processedAt: true,
          payment: {
            select: {
              payee: true,
              bookingId: true,
              booking: { select: { serviceNameSnapshot: true } },
            },
          },
        },
        take: 500,
      }),
      this.prisma.billingCharge.findMany({
        where: { status: 'PAID', paidAt: { gte: from, lte: to }, membership: { barbershopId } },
        select: {
          amount: true,
          paidAt: true,
          membership: { select: { membershipPlan: { select: { name: true } } } },
        },
        take: 500,
      }),
      this.prisma.balanceMovement.findMany({
        where: { barbershopId, createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.balanceOf(barbershopId),
    ]);
    const lines: StatementLineDto[] = [];
    for (const p of payments) {
      const direct = p.payee === 'SELLER';
      const commission = direct ? (p.marketplaceFee ?? 0) : p.booking.commissionAmount;
      const attended = p.booking.status === 'ATTENDED';
      lines.push({
        at: p.confirmedAt!,
        kind: direct ? 'BOOKING_DIRECT' : 'BOOKING',
        description: `Reserva: ${p.booking.serviceNameSnapshot}`,
        gross: p.amount,
        commission,
        net: direct ? 0 : p.amount - commission,
        payee: direct ? 'SELLER' : 'PLATFORM',
        state: direct ? 'INFO' : attended ? 'AVAILABLE' : 'PENDING',
        bookingId: p.booking.id,
      });
    }
    for (const r of refunds) {
      const direct = r.payment.payee === 'SELLER';
      lines.push({
        at: r.processedAt!,
        kind: 'REFUND',
        description: `Devolución: ${r.payment.booking.serviceNameSnapshot}`,
        gross: -r.amount,
        commission: 0,
        net: direct ? 0 : -r.amount,
        payee: direct ? 'SELLER' : 'PLATFORM',
        state: direct ? 'INFO' : 'AVAILABLE',
        bookingId: r.payment.bookingId,
      });
    }
    for (const c of charges) {
      const commission = Math.round((c.amount * feeBp) / 10_000);
      lines.push({
        at: c.paidAt!,
        kind: 'MEMBERSHIP',
        description: `Membresía: ${c.membership?.membershipPlan.name ?? ''}`.trim(),
        gross: c.amount,
        commission,
        net: c.amount - commission,
        payee: 'PLATFORM',
        state: 'AVAILABLE',
        bookingId: null,
      });
    }
    for (const m of movements) {
      lines.push({
        at: m.createdAt,
        kind: m.type,
        description:
          m.type === 'SUBSCRIPTION_PAYMENT'
            ? 'Pago del plan con saldo'
            : m.type === 'PAYOUT'
              ? `Transferencia de Charles${m.reference ? ` (${m.reference})` : ''}`
              : (m.note ?? 'Ajuste'),
        gross: 0,
        commission: 0,
        net: m.amount,
        payee: 'NONE',
        state: 'AVAILABLE',
        bookingId: null,
      });
    }
    lines.sort((a, b) => b.at.getTime() - a.at.getTime());
    const sales = lines.filter((l) => l.gross !== 0);
    return {
      balance,
      from,
      to,
      gross: sales.reduce((s, l) => s + l.gross, 0),
      commission: sales.reduce((s, l) => s + l.commission, 0),
      net: sales.reduce((s, l) => s + l.gross - l.commission, 0),
      lines: lines.slice(0, 500),
    };
  }

  // ───────────── ADMIN ─────────────

  /** Barberías con saldo o con movimientos (para liquidar). */
  async adminList(): Promise<AdminBalanceDto[]> {
    const shops = await this.prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT DISTINCT s.id::text AS id, s.name
        FROM barbershops s
       WHERE s.deleted_at IS NULL AND (
         EXISTS (SELECT 1 FROM bookings b JOIN payments p ON p.booking_id = b.id
                  WHERE b.barbershop_id = s.id AND p.payee = 'PLATFORM'
                    AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED'))
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.barbershop_id = s.id)
         OR EXISTS (SELECT 1 FROM balance_movements bm WHERE bm.barbershop_id = s.id))
       ORDER BY s.name
       LIMIT 500`;
    const result: AdminBalanceDto[] = [];
    for (const shop of shops) {
      const [balance, last] = await Promise.all([
        this.balanceOf(shop.id),
        this.prisma.balanceMovement.findFirst({
          where: { barbershopId: shop.id, type: 'PAYOUT' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);
      result.push({
        ...balance,
        barbershopId: shop.id,
        barbershopName: shop.name,
        lastPayoutAt: last?.createdAt ?? null,
      });
    }
    return result.sort((a, b) => b.available - a.available);
  }

  async adminMovements(barbershopId: string): Promise<BalanceMovementDto[]> {
    const rows = await this.prisma.balanceMovement.findMany({
      where: { barbershopId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((m) => ({
      id: m.id,
      type: m.type,
      amount: m.amount,
      reference: m.reference,
      note: m.note,
      createdAt: m.createdAt,
    }));
  }

  /** Liquidación (transferencia hecha por Charles) o ajuste. Una liquidación no puede superar el saldo. */
  async adminCreate(
    actor: StaffActor,
    barbershopId: string,
    dto: CreateBalanceMovementDto,
  ): Promise<BalanceMovementDto> {
    const shop = await this.prisma.barbershop.findUnique({
      where: { id: barbershopId },
      select: { id: true },
    });
    if (!shop)
      throw new AppException(ErrorCode.NOT_FOUND, 'La barbería no existe.', HttpStatus.NOT_FOUND);
    if (dto.type === 'PAYOUT' && dto.amount < 0) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'La transferencia va en positivo.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'amount', constraints: ['positive'] }],
      );
    }
    const amount = dto.type === 'PAYOUT' ? -dto.amount : dto.amount;
    const row = await this.prisma.$transaction(async (tx) => {
      if (dto.type === 'PAYOUT') {
        const available = await this.lockAvailable(tx, barbershopId);
        if (dto.amount > available) throw insufficient(available);
      }
      const created = await tx.balanceMovement.create({
        data: {
          barbershopId,
          type: dto.type,
          amount,
          reference: dto.reference ?? null,
          note: dto.note ?? null,
          createdById: actor.id,
        },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: dto.type === 'PAYOUT' ? 'balance.payout' : 'balance.adjustment',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: { amount, reference: dto.reference ?? null, role: actor.role },
        },
        tx,
      );
      return created;
    });
    return {
      id: row.id,
      type: row.type,
      amount: row.amount,
      reference: row.reference,
      note: row.note,
      createdAt: row.createdAt,
    };
  }
}

export const insufficient = (available: number): AppException =>
  new AppException(
    ErrorCode.INSUFFICIENT_BALANCE,
    `Saldo insuficiente: tienes S/ ${(available / 100).toFixed(2)} disponibles.`,
    HttpStatus.CONFLICT,
  );

// ───────────── Controladores ─────────────

const uuid = new ParseUUIDPipe();

@ApiTags('balance')
@ApiBearerAuth()
@ApiNotFoundResponse({ type: ErrorResponseDto })
@Controller('barbershops/:id')
export class BalanceController {
  constructor(private readonly balance: BalanceService) {}

  @Get('balance')
  @ApiOperation({
    summary: 'OWNER o MANAGER: saldo a favor (disponible, pendiente y cobrado directo)',
  })
  @ApiOkResponse({ type: BalanceDto })
  get(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<BalanceDto> {
    return this.balance.balance(user.id, id);
  }

  @Get('statement')
  @ApiOperation({
    summary: 'OWNER o MANAGER: estado de cuenta (cobros, comisiones, devoluciones y movimientos)',
  })
  @ApiOkResponse({ type: StatementDto })
  statement(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Query() query: StatementQueryDto,
  ): Promise<StatementDto> {
    return this.balance.statement(user.id, id, query);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@AdminOnly()
@UseGuards(AdminAccessGuard)
@Controller('admin/balances')
export class BalanceAdminController {
  constructor(private readonly balance: BalanceService) {}

  @Get()
  @ApiOperation({ summary: 'Solo ADMIN: saldo de cada barbería (para liquidar)' })
  @ApiOkResponse({ type: [AdminBalanceDto] })
  list(): Promise<AdminBalanceDto[]> {
    return this.balance.adminList();
  }

  @Get(':barbershopId/movements')
  @ApiOperation({ summary: 'Solo ADMIN: movimientos del saldo de una barbería' })
  @ApiOkResponse({ type: [BalanceMovementDto] })
  movements(@Param('barbershopId', uuid) barbershopId: string): Promise<BalanceMovementDto[]> {
    return this.balance.adminMovements(barbershopId);
  }

  @Post(':barbershopId/movements')
  @ApiOperation({ summary: 'Solo ADMIN: registrar una transferencia (PAYOUT) o un ajuste' })
  @ApiCreatedResponse({ type: BalanceMovementDto })
  create(
    @CurrentStaff() staff: StaffActor,
    @Param('barbershopId', uuid) barbershopId: string,
    @Body() dto: CreateBalanceMovementDto,
  ): Promise<BalanceMovementDto> {
    return this.balance.adminCreate(staff, barbershopId, dto);
  }
}

/** Saldo a favor y estado de cuenta de las barberías. */
@Module({
  imports: [BarbershopAccessModule, AdminAccessModule, SettingsModule],
  controllers: [BalanceController, BalanceAdminController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
