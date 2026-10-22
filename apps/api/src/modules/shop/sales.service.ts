import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { DAY_MS } from '../billing/billing-gateway';
import { consumeCredit, restoreCredit } from '../memberships/membership-credits';
import { EntitlementsService } from '../plans/entitlements.service';
import type {
  CashSessionDto,
  CloseCashDto,
  CreateSaleDto,
  InvoiceDto,
  InvoicingConfigDto,
  OpenCashDto,
  SaleDto,
  SalesQueryDto,
  UpdateInvoicingConfigDto,
} from './dto/shop.dto';
import {
  FakeInvoiceProvider,
  InvoiceProviderError,
  NubefactInvoiceProvider,
  taxIncluded,
} from './invoice-provider';

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SUNAT: desde S/ 700 la boleta debe identificar al comprador. */
const IDENTIFIED_FROM = 70_000;
const MAX_INVOICE_ATTEMPTS = 5;

const saleInclude = {
  lines: true,
  invoice: true,
  shopClient: { select: { displayName: true } },
  barber: { select: { displayName: true } },
} satisfies Prisma.LocalSaleInclude;
type SaleRow = Prisma.LocalSaleGetPayload<{ include: typeof saleInclude }>;

const invalid = (
  field: string,
  constraint: string,
  message = 'Los datos enviados no son válidos.',
) =>
  new AppException(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, [
    { field, constraints: [constraint] },
  ]);
const notFound = (what: string): AppException =>
  new AppException(ErrorCode.NOT_FOUND, `${what} no existe.`, HttpStatus.NOT_FOUND);

/** Inicio del día de Lima que contiene `at`. */
export const limaDayStart = (at: number): Date => {
  const lima = new Date(at - 5 * 3_600_000);
  return new Date(Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate(), 5));
};

/**
 * Panel de la barbería: caja del local, ventas sin reserva previa (con o sin cliente registrado)
 * y boletas electrónicas. La boleta se emite **fuera** de la transacción de la venta (regla 12): la
 * venta guarda la boleta PENDING con su número y un trabajo la envía y reintenta.
 */
@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly fakeInvoices: FakeInvoiceProvider,
    private readonly nubefact: NubefactInvoiceProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ───────────── Caja ─────────────

  async currentCash(userId: string, barbershopId: string): Promise<CashSessionDto | null> {
    await this.access.requireMember(userId, barbershopId);
    const open = await this.prisma.cashSession.findFirst({
      where: { barbershopId, closedAt: null },
    });
    return open ? this.cashDto(open.id) : null;
  }

  async cashHistory(userId: string, barbershopId: string): Promise<CashSessionDto[]> {
    await this.access.requireMember(userId, barbershopId);
    const rows = await this.prisma.cashSession.findMany({
      where: { barbershopId },
      orderBy: { openedAt: 'desc' },
      take: 30,
      select: { id: true },
    });
    return Promise.all(rows.map((r) => this.cashDto(r.id)));
  }

  async openCash(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: OpenCashDto,
  ): Promise<CashSessionDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    try {
      const session = await this.prisma.$transaction(async (tx) => {
        const created = await tx.cashSession.create({
          data: {
            barbershopId,
            openedById: actor.userId,
            openedAt: new Date(this.clock.now()),
            openingAmount: dto.openingAmount,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'cash.opened',
            entityType: 'cash_session',
            entityId: created.id,
            changes: { barbershopId, openingAmount: dto.openingAmount },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return created;
      });
      return this.cashDto(session.id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CASH_SESSION_OPEN,
          'Ya hay una caja abierta.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async closeCash(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: CloseCashDto,
  ): Promise<CashSessionDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    const open = await this.prisma.cashSession.findFirst({
      where: { barbershopId, closedAt: null },
    });
    if (!open) {
      throw new AppException(
        ErrorCode.CASH_SESSION_REQUIRED,
        'No hay una caja abierta.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cash_sessions WHERE id = ${open.id}::uuid FOR UPDATE`;
      const cash = await tx.localSale.aggregate({
        where: { cashSessionId: open.id, status: 'COMPLETED', paymentMethod: 'CASH' },
        _sum: { totalAmount: true },
      });
      const expected = open.openingAmount + (cash._sum.totalAmount ?? 0);
      await tx.cashSession.update({
        where: { id: open.id },
        data: {
          closedAt: new Date(this.clock.now()),
          closedById: actor.userId,
          expectedAmount: expected,
          countedAmount: dto.countedAmount,
          note: dto.note || null,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'cash.closed',
          entityType: 'cash_session',
          entityId: open.id,
          changes: {
            expected,
            counted: dto.countedAmount,
            difference: dto.countedAmount - expected,
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return this.cashDto(open.id);
  }

  private async cashDto(id: string): Promise<CashSessionDto> {
    const s = await this.prisma.cashSession.findUniqueOrThrow({ where: { id } });
    const [all, cash] = await Promise.all([
      this.prisma.localSale.aggregate({
        where: { cashSessionId: id, status: 'COMPLETED' },
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      this.prisma.localSale.aggregate({
        where: { cashSessionId: id, status: 'COMPLETED', paymentMethod: 'CASH' },
        _sum: { totalAmount: true },
      }),
    ]);
    const expected = s.expectedAmount ?? s.openingAmount + (cash._sum.totalAmount ?? 0);
    return {
      id: s.id,
      openedAt: s.openedAt,
      openingAmount: s.openingAmount,
      closedAt: s.closedAt,
      expectedAmount: expected,
      countedAmount: s.countedAmount,
      difference: s.countedAmount === null ? null : s.countedAmount - expected,
      salesCount: all._count._all,
      salesTotal: all._sum.totalAmount ?? 0,
      note: s.note,
    };
  }

  // ───────────── Ventas ─────────────

  async list(userId: string, barbershopId: string, query: SalesQueryDto): Promise<SaleDto[]> {
    await this.access.requireMember(userId, barbershopId);
    const from = query.from ?? limaDayStart(this.clock.now());
    const to = query.to ?? new Date(from.getTime() + DAY_MS);
    const rows = await this.prisma.localSale.findMany({
      where: {
        barbershopId,
        soldAt: { gte: from, lt: to },
        ...(query.barberId ? { barberId: query.barberId } : {}),
      },
      include: saleInclude,
      orderBy: { soldAt: 'desc' },
      take: 500,
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(userId: string, barbershopId: string, saleId: string): Promise<SaleDto> {
    await this.access.requireMember(userId, barbershopId);
    return this.toDto(await this.find(barbershopId, saleId));
  }

  async create(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    idempotencyKey: string | undefined,
    dto: CreateSaleDto,
  ): Promise<{ sale: SaleDto; replayed: boolean }> {
    await this.access.requireMember(actor.userId, barbershopId);
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'Falta la cabecera Idempotency-Key (UUID).',
        HttpStatus.BAD_REQUEST,
      );
    }
    const replay = await this.prisma.localSale.findUnique({
      where: { barbershopId_idempotencyKey: { barbershopId, idempotencyKey } },
      include: saleInclude,
    });
    if (replay) return { sale: this.toDto(replay), replayed: true };

    const now = this.clock.now();
    const used = await this.prisma.localSale.count({
      where: { barbershopId, soldAt: { gte: this.entitlements.monthStart(now) } },
    });
    await this.entitlements.assertWithin(barbershopId, 'local_sales_month', used);

    // Líneas: servicios propios (precio por defecto) o descripción libre.
    const serviceIds = dto.lines.map((l) => l.serviceId).filter((id): id is string => !!id);
    const services = serviceIds.length
      ? await this.prisma.service.findMany({
          where: { id: { in: serviceIds }, barbershopId, deletedAt: null },
          select: { id: true, name: true, priceAmount: true },
        })
      : [];
    const byId = new Map(services.map((s) => [s.id, s]));
    const lines = dto.lines.map((l, i) => {
      const service = l.serviceId ? byId.get(l.serviceId) : undefined;
      if (l.serviceId && !service) throw invalid(`lines.${i}.serviceId`, 'serviceOfBarbershop');
      const description = l.description ?? service?.name;
      if (!description) throw invalid(`lines.${i}.description`, 'isNotEmpty');
      const unitAmount = l.unitAmount ?? service?.priceAmount;
      if (unitAmount === undefined) throw invalid(`lines.${i}.unitAmount`, 'isNotEmpty');
      const quantity = l.quantity ?? 1;
      return {
        serviceId: service?.id ?? null,
        description,
        quantity,
        unitAmount,
        totalAmount: quantity * unitAmount,
      };
    });
    const subtotal = lines.reduce((sum, l) => sum + l.totalAmount, 0);
    const discount = dto.discountAmount ?? 0;
    if (discount > subtotal) throw invalid('discountAmount', 'notAboveSubtotal');
    const total = subtotal - discount;

    const client = dto.shopClientId
      ? await this.prisma.shopClient.findFirst({
          where: { id: dto.shopClientId, barbershopId },
          select: { id: true, userId: true },
        })
      : null;
    if (dto.shopClientId && !client) throw invalid('shopClientId', 'clientOfBarbershop');
    if (dto.barberId) {
      const barber = await this.prisma.barber.count({
        where: { id: dto.barberId, barbershopId, deletedAt: null },
      });
      if (!barber) throw invalid('barberId', 'barberOfBarbershop');
    }
    const byCredit = dto.paymentMethod === 'MEMBERSHIP_CREDIT';
    if (byCredit && (!dto.membershipId || !client?.userId))
      throw invalid('membershipId', 'membershipOfClient');
    if (!byCredit && dto.membershipId) throw invalid('membershipId', 'onlyWithMembershipCredit');
    if (dto.issueInvoice && byCredit) throw invalid('issueInvoice', 'notWithMembershipCredit');
    const customer = dto.customer ?? { type: 'NONE' as const };
    if (dto.issueInvoice) {
      if (total >= IDENTIFIED_FROM && (customer.type === 'NONE' || !customer.number)) {
        throw invalid(
          'customer',
          'identifiedFrom700',
          'Desde S/ 700 la boleta debe llevar el documento del comprador.',
        );
      }
      if (customer.type !== 'NONE' && !customer.number)
        throw invalid('customer.number', 'isNotEmpty');
    }

    let saleId: string;
    try {
      saleId = await this.prisma.$transaction(async (tx) => {
        const open = await tx.cashSession.findFirst({
          where: { barbershopId, closedAt: null },
          select: { id: true },
        });
        if (dto.paymentMethod === 'CASH' && !open) {
          throw new AppException(
            ErrorCode.CASH_SESSION_REQUIRED,
            'Abre la caja antes de cobrar en efectivo.',
            HttpStatus.CONFLICT,
          );
        }
        const sale = await tx.localSale.create({
          data: {
            barbershopId,
            shopClientId: client?.id ?? null,
            barberId: dto.barberId ?? null,
            cashSessionId: open?.id ?? null,
            membershipId: byCredit ? dto.membershipId! : null,
            subtotalAmount: subtotal,
            discountAmount: discount,
            totalAmount: total,
            currency: 'PEN',
            paymentMethod: dto.paymentMethod,
            createdById: actor.userId,
            idempotencyKey,
            soldAt: new Date(now),
            lines: { create: lines },
          },
          select: { id: true },
        });
        if (byCredit) {
          await consumeCredit(tx, {
            membershipId: dto.membershipId!,
            barbershopId,
            userId: client!.userId,
            serviceIds: lines.map((l) => l.serviceId).filter((id): id is string => !!id),
            saleId: sale.id,
            now,
          });
        }
        if (dto.issueInvoice) {
          const [config] = await tx.$queryRaw<
            { series: string; next_number: number; provider: string; enabled: boolean }[]
          >`
            SELECT series, next_number, provider, enabled FROM invoicing_configs
             WHERE barbershop_id = ${barbershopId}::uuid FOR UPDATE`;
          if (!config?.enabled) {
            throw new AppException(
              ErrorCode.INVOICING_NOT_CONFIGURED,
              'Configura la emisión de boletas antes de emitirlas.',
              HttpStatus.CONFLICT,
            );
          }
          await tx.invoicingConfig.update({
            where: { barbershopId },
            data: { nextNumber: config.next_number + 1 },
          });
          await tx.invoice.create({
            data: {
              barbershopId,
              saleId: sale.id,
              series: config.series,
              number: config.next_number,
              customerName: customer.name ?? null,
              customerDocType: customer.type,
              customerDocEnc: customer.number
                ? this.encryption.encrypt(customer.number, EncryptedField.INVOICE_CUSTOMER_DOC)
                : null,
              totalAmount: total,
              taxAmount: taxIncluded(total),
              currency: 'PEN',
              provider: config.provider,
            },
          });
        }
        if (client) {
          await tx.shopClient.update({
            where: { id: client.id },
            data: { lastVisitAt: new Date(now), visitsCount: { increment: 1 } },
          });
        }
        await this.audit.record(
          {
            actorId: actor.userId,
            action: 'sale.created',
            entityType: 'local_sale',
            entityId: sale.id,
            changes: {
              barbershopId,
              total,
              method: dto.paymentMethod,
              invoice: dto.issueInvoice ?? false,
            },
            ip: actor.ip ?? null,
          },
          tx,
        );
        return sale.id;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const again = await this.prisma.localSale.findUnique({
          where: { barbershopId_idempotencyKey: { barbershopId, idempotencyKey } },
          include: saleInclude,
        });
        if (again) return { sale: this.toDto(again), replayed: true };
      }
      throw error;
    }
    const invoice = await this.prisma.invoice.findUnique({
      where: { saleId },
      select: { id: true },
    });
    if (invoice) await this.issue(invoice.id);
    return { sale: this.toDto(await this.find(barbershopId, saleId)), replayed: false };
  }

  /** Anula una venta (con motivo): devuelve el crédito de membresía si se usó. */
  async voidSale(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    saleId: string,
    reason: string,
  ): Promise<SaleDto> {
    await this.access.requireMember(actor.userId, barbershopId);
    const sale = await this.find(barbershopId, saleId);
    if (sale.status === 'VOIDED') {
      throw new AppException(
        ErrorCode.SALE_ALREADY_VOIDED,
        'La venta ya está anulada.',
        HttpStatus.CONFLICT,
      );
    }
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.localSale.updateMany({
        where: { id: saleId, status: 'COMPLETED' },
        data: {
          status: 'VOIDED',
          voidReason: reason,
          voidedAt: new Date(now),
          voidedById: actor.userId,
        },
      });
      if (count === 0) {
        throw new AppException(
          ErrorCode.SALE_ALREADY_VOIDED,
          'La venta ya está anulada.',
          HttpStatus.CONFLICT,
        );
      }
      await restoreCredit(tx, { saleId }, now);
      // Boleta aún no enviada: ya no se emite. Una emitida se anula con nota de crédito en el
      // sistema del proveedor (fuera de Charles).
      await tx.invoice.updateMany({
        where: { saleId, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'VOIDED' },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'sale.voided',
          entityType: 'local_sale',
          entityId: saleId,
          changes: { reason },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return this.toDto(await this.find(barbershopId, saleId));
  }

  // ───────────── Boletas ─────────────

  async invoicingConfig(userId: string, barbershopId: string): Promise<InvoicingConfigDto> {
    await this.access.requireMember(userId, barbershopId);
    const c = await this.prisma.invoicingConfig.findUnique({ where: { barbershopId } });
    return c
      ? {
          provider: c.provider as InvoicingConfigDto['provider'],
          enabled: c.enabled,
          series: c.series,
          nextNumber: c.nextNumber,
          hasCredentials: !!(c.apiUrlEnc && c.tokenEnc),
        }
      : { provider: 'FAKE', enabled: false, series: 'B001', nextNumber: 1, hasCredentials: false };
  }

  async updateInvoicingConfig(
    actor: { userId: string; ip?: string | null },
    barbershopId: string,
    dto: UpdateInvoicingConfigDto,
  ): Promise<InvoicingConfigDto> {
    await this.access.requireMember(actor.userId, barbershopId, ['OWNER']);
    const existing = await this.prisma.invoicingConfig.findUnique({ where: { barbershopId } });
    const apiUrlEnc = dto.apiUrl
      ? this.encryption.encrypt(dto.apiUrl, EncryptedField.INVOICING_API_URL)
      : existing?.apiUrlEnc;
    const tokenEnc = dto.token
      ? this.encryption.encrypt(dto.token, EncryptedField.INVOICING_TOKEN)
      : existing?.tokenEnc;
    if (dto.provider === 'NUBEFACT' && dto.enabled && !(apiUrlEnc && tokenEnc)) {
      throw invalid(
        'token',
        'nubefactCredentials',
        'Para Nubefact, envía la RUTA y el TOKEN de tu cuenta.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.invoicingConfig.upsert({
        where: { barbershopId },
        create: {
          barbershopId,
          provider: dto.provider,
          enabled: dto.enabled,
          series: dto.series,
          apiUrlEnc: apiUrlEnc ?? null,
          tokenEnc: tokenEnc ?? null,
        },
        update: {
          provider: dto.provider,
          enabled: dto.enabled,
          // Cambiar de serie reinicia la numeración.
          ...(existing && existing.series !== dto.series
            ? { series: dto.series, nextNumber: 1 }
            : {}),
          apiUrlEnc: apiUrlEnc ?? null,
          tokenEnc: tokenEnc ?? null,
        },
      });
      await this.audit.record(
        {
          actorId: actor.userId,
          action: 'invoicing.configured',
          entityType: 'barbershop',
          entityId: barbershopId,
          changes: {
            provider: dto.provider,
            enabled: dto.enabled,
            series: dto.series,
            credentialsChanged: !!(dto.apiUrl || dto.token),
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
    return this.invoicingConfig(actor.userId, barbershopId);
  }

  async retryInvoice(userId: string, barbershopId: string, saleId: string): Promise<SaleDto> {
    await this.access.requireMember(userId, barbershopId);
    const invoice = await this.prisma.invoice.findFirst({ where: { saleId, barbershopId } });
    if (!invoice) throw notFound('La boleta');
    if (invoice.status === 'FAILED' || invoice.status === 'PENDING') {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'PENDING', attempts: 0 },
      });
      await this.issue(invoice.id);
    }
    return this.get(userId, barbershopId, saleId);
  }

  /** Envía una boleta al proveedor (fuera de toda transacción). */
  async issue(invoiceId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { sale: { include: { lines: true } } },
    });
    if (!invoice || invoice.status !== 'PENDING') return;
    const config = await this.prisma.invoicingConfig.findUnique({
      where: { barbershopId: invoice.barbershopId },
    });
    const request = {
      series: invoice.series,
      number: invoice.number,
      issuedAt: invoice.createdAt,
      currency: invoice.currency,
      totalAmount: invoice.totalAmount,
      taxAmount: invoice.taxAmount,
      customer: {
        docType: (invoice.customerDocType ?? 'NONE') as 'DNI' | 'CE' | 'RUC' | 'NONE',
        docNumber: invoice.customerDocEnc
          ? this.encryption.decrypt(invoice.customerDocEnc, EncryptedField.INVOICE_CUSTOMER_DOC)
          : null,
        name: invoice.customerName,
      },
      // El descuento se reparte en la última línea (la boleta debe sumar el total cobrado).
      lines: discounted(invoice.sale.lines, invoice.sale.discountAmount),
    };
    try {
      const result =
        invoice.provider === 'NUBEFACT'
          ? await this.nubefact.issue(request, {
              apiUrl: config?.apiUrlEnc
                ? this.encryption.decrypt(config.apiUrlEnc, EncryptedField.INVOICING_API_URL)
                : null,
              token: config?.tokenEnc
                ? this.encryption.decrypt(config.tokenEnc, EncryptedField.INVOICING_TOKEN)
                : null,
            })
          : await this.fakeInvoices.issue(request);
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          status: result.status,
          pdfUrl: result.pdfUrl,
          providerData: result.providerData as Prisma.InputJsonValue,
          lastError: result.error,
          attempts: { increment: 1 },
          issuedAt: result.status === 'ISSUED' ? new Date(this.clock.now()) : null,
        },
      });
    } catch (error) {
      if (!(error instanceof InvoiceProviderError)) throw error;
      const attempts = invoice.attempts + 1;
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          attempts,
          lastError: error.message,
          status: attempts >= MAX_INVOICE_ATTEMPTS ? 'FAILED' : 'PENDING',
        },
      });
    }
  }

  /** Trabajo periódico: reintenta las boletas pendientes. */
  async issuePending(): Promise<number> {
    const pending = await this.prisma.invoice.findMany({
      where: { status: 'PENDING', attempts: { lt: MAX_INVOICE_ATTEMPTS } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { id: true },
    });
    for (const inv of pending) {
      try {
        await this.issue(inv.id);
      } catch (error) {
        this.logger.warn(`Boleta ${inv.id}: ${(error as Error).message}`);
      }
    }
    return pending.length;
  }

  // ───────────── Apoyo ─────────────

  private async find(barbershopId: string, saleId: string): Promise<SaleRow> {
    const row = await this.prisma.localSale.findFirst({
      where: { id: saleId, barbershopId },
      include: saleInclude,
    });
    if (!row) throw notFound('La venta');
    return row;
  }

  private toDto(r: SaleRow): SaleDto {
    return {
      id: r.id,
      shopClientId: r.shopClientId,
      clientName: r.shopClient?.displayName ?? null,
      barberId: r.barberId,
      barberName: r.barber?.displayName ?? null,
      lines: r.lines.map((l) => ({
        serviceId: l.serviceId,
        description: l.description,
        quantity: l.quantity,
        unitAmount: l.unitAmount,
        totalAmount: l.totalAmount,
      })),
      subtotalAmount: r.subtotalAmount,
      discountAmount: r.discountAmount,
      totalAmount: r.totalAmount,
      currency: r.currency,
      paymentMethod: r.paymentMethod,
      status: r.status,
      voidReason: r.voidReason,
      invoice: r.invoice ? toInvoiceDto(r.invoice) : null,
      soldAt: r.soldAt,
    };
  }
}

function toInvoiceDto(i: Prisma.InvoiceGetPayload<object>): InvoiceDto {
  return {
    id: i.id,
    number: `${i.series}-${String(i.number).padStart(8, '0')}`,
    status: i.status,
    totalAmount: i.totalAmount,
    taxAmount: i.taxAmount,
    pdfUrl: i.pdfUrl,
    lastError: i.lastError,
    issuedAt: i.issuedAt,
  };
}

/** Líneas con el descuento aplicado (de la última hacia atrás), para que sumen el total. */
export function discounted(
  lines: { description: string; quantity: number; unitAmount: number; totalAmount: number }[],
  discount: number,
): { description: string; quantity: number; unitAmount: number; totalAmount: number }[] {
  let left = discount;
  const out = lines.map((l) => ({ ...l }));
  for (let i = out.length - 1; i >= 0 && left > 0; i--) {
    const line = out[i]!;
    const cut = Math.min(left, line.totalAmount);
    line.totalAmount -= cut;
    line.unitAmount = Math.round(line.totalAmount / line.quantity);
    left -= cut;
  }
  return out;
}
