import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { APP_CONFIG } from '../../common/config/app-config.token';
import type { AppConfig } from '../../common/config/env.validation';
import { EncryptedField } from '../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../common/crypto/encryption.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MAILER, type Mailer } from '../../common/mail/mailer';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import {
  BILLING_GATEWAY,
  type BillingGateway,
  BillingGatewayError,
  billingReference,
  DAY_MS,
} from '../billing/billing-gateway';
import {
  type AfterCommit,
  type BillingPaymentEvent,
  BillingWebhooksService,
} from '../billing/billing-webhooks.service';
import type {
  CreatePackagePurchaseDto,
  CreateSponsorPackageDto,
  PackagePurchaseDto,
  SponsorPackageDto,
  UpdateSponsorPackageDto,
} from './dto/sponsor-package.dto';

type Tx = Prisma.TransactionClient;
type PackageRow = Prisma.SponsorPackageGetPayload<object>;
const purchaseInclude = { package: true } satisfies Prisma.SponsorPackagePurchaseInclude;
type PurchaseRow = Prisma.SponsorPackagePurchaseGetPayload<{ include: typeof purchaseInclude }>;

const notFound = (what: string): AppException =>
  new AppException(ErrorCode.NOT_FOUND, `${what} no existe.`, HttpStatus.NOT_FOUND);

/**
 * Paquetes para auspiciadores (Fase 15): catálogo de ADMIN y compra con enlace de pago. Al
 * pagarse, la campaña se activa por los días del paquete, con su tope de impresiones y de anuncios.
 * Charles no cobra dentro de la app: el enlace llega por correo al auspiciador.
 */
@Injectable()
export class SponsorPackagesService implements OnModuleInit {
  private readonly logger = new Logger(SponsorPackagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly encryption: EncryptionService,
    private readonly webhooks: BillingWebhooksService,
    @Inject(BILLING_GATEWAY) private readonly gateway: BillingGateway,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.webhooks.register('spk', { onPayment: (tx, id, event) => this.onPayment(tx, id, event) });
  }

  // ───────────── Catálogo ─────────────

  async list(): Promise<SponsorPackageDto[]> {
    const rows = await this.prisma.sponsorPackage.findMany({
      orderBy: [{ sortOrder: 'asc' }, { priceAmount: 'asc' }],
    });
    return rows.map(toPackageDto);
  }

  async create(actorId: string, dto: CreateSponsorPackageDto): Promise<SponsorPackageDto> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.sponsorPackage.create({
          data: {
            code: dto.code,
            name: dto.name,
            description: dto.description || null,
            priceAmount: dto.priceAmount,
            impressionsLimit: dto.impressionsLimit ?? null,
            placementsLimit: dto.placementsLimit,
            durationDays: dto.durationDays,
            sortOrder: dto.sortOrder ?? 0,
          },
        });
        await this.audit.record(
          {
            actorId,
            action: 'sponsor_package.created',
            entityType: 'sponsor_package',
            entityId: created.id,
            changes: { code: dto.code },
          },
          tx,
        );
        return created;
      });
      return toPackageDto(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.CONFLICT,
          'Ya existe un paquete con ese código.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  async update(
    actorId: string,
    id: string,
    dto: UpdateSponsorPackageDto,
  ): Promise<SponsorPackageDto> {
    const exists = await this.prisma.sponsorPackage.count({ where: { id } });
    if (!exists) throw notFound('El paquete');
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.sponsorPackage.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description === undefined ? undefined : dto.description || null,
          priceAmount: dto.priceAmount,
          impressionsLimit: dto.impressionsLimit,
          placementsLimit: dto.placementsLimit,
          durationDays: dto.durationDays,
          sortOrder: dto.sortOrder,
          isActive: dto.isActive,
        },
      });
      await this.audit.record(
        {
          actorId,
          action: 'sponsor_package.updated',
          entityType: 'sponsor_package',
          entityId: id,
          changes: { ...dto },
        },
        tx,
      );
      return updated;
    });
    return toPackageDto(row);
  }

  // ───────────── Compras ─────────────

  async purchases(sponsorId: string): Promise<PackagePurchaseDto[]> {
    const rows = await this.prisma.sponsorPackagePurchase.findMany({
      where: { sponsorId },
      include: purchaseInclude,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPurchaseDto);
  }

  /** ADMIN prepara la compra: campaña en borrador y enlace de pago al correo del auspiciador. */
  async createPurchase(
    actorId: string,
    sponsorId: string,
    dto: CreatePackagePurchaseDto,
  ): Promise<PackagePurchaseDto> {
    const [sponsor, pkg] = await Promise.all([
      this.prisma.sponsor.findFirst({
        where: { id: sponsorId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.sponsorPackage.findFirst({ where: { id: dto.packageId, isActive: true } }),
    ]);
    if (!sponsor) throw notFound('El auspiciador');
    if (!pkg) throw notFound('El paquete');
    const now = this.clock.now();
    const purchase = await this.prisma.$transaction(async (tx) => {
      const campaign = await tx.sponsorCampaign.create({
        data: {
          sponsorId,
          name: dto.campaignName,
          startsAt: new Date(now),
          endsAt: new Date(now + pkg.durationDays * DAY_MS),
          audience: dto.audience ?? 'ALL',
          status: 'DRAFT',
          impressionsLimit: pkg.impressionsLimit,
        },
        select: { id: true },
      });
      const created = await tx.sponsorPackagePurchase.create({
        data: {
          sponsorId,
          packageId: pkg.id,
          campaignId: campaign.id,
          priceAmount: pkg.priceAmount,
          currency: pkg.currency,
          payerEmailEnc: this.encryption.encrypt(
            dto.payerEmail,
            EncryptedField.SPONSOR_PAYER_EMAIL,
          ),
          createdById: actorId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          actorId,
          action: 'sponsor_package.purchase_created',
          entityType: 'sponsor_package_purchase',
          entityId: created.id,
          changes: { sponsorId, package: pkg.code, campaignId: campaign.id },
        },
        tx,
      );
      return created;
    });
    if (pkg.priceAmount === 0) {
      // Cortesía: se activa sin cobro.
      await this.prisma.$transaction((tx) => this.activate(tx, purchase.id));
      return this.purchase(purchase.id);
    }
    let checkout;
    try {
      checkout = await this.gateway.createCheckout({
        reference: billingReference('spk', purchase.id),
        title: `Paquete ${pkg.name} — ${sponsor.name}`,
        amount: pkg.priceAmount,
        currency: pkg.currency,
        backUrl: `${this.config.payments.publicApiUrl ?? 'https://charles.invalid'}/api/v1/payments/done?status=pending`,
        idempotencyKey: purchase.id,
      });
    } catch (error) {
      await this.prisma.sponsorPackagePurchase.update({
        where: { id: purchase.id },
        data: { status: 'CANCELED' },
      });
      if (error instanceof BillingGatewayError) {
        throw new AppException(
          ErrorCode.BILLING_UNAVAILABLE,
          'No pudimos conectar con la pasarela de pagos. Intenta en unos minutos.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
    await this.prisma.sponsorPackagePurchase.update({
      where: { id: purchase.id },
      data: { checkoutUrl: checkout.checkoutUrl },
    });
    await this.mailer.send({
      to: dto.payerEmail,
      subject: `Paquete ${pkg.name} en Charles: completa el pago`,
      text:
        `Hola, ${sponsor.name}.\n\nPara activar tu campaña «${dto.campaignName}» con el paquete ${pkg.name}, ` +
        `completa el pago en este enlace:\n${checkout.checkoutUrl}\n\nLa campaña se activa al confirmarse el pago.`,
      category: 'sponsor-package-checkout',
    });
    return this.purchase(purchase.id);
  }

  async cancelPurchase(actorId: string, id: string): Promise<PackagePurchaseDto> {
    const row = await this.prisma.sponsorPackagePurchase.findUnique({ where: { id } });
    if (!row) throw notFound('La compra');
    if (row.status !== 'PENDING') {
      throw new AppException(
        ErrorCode.CONFLICT,
        'Solo se anula una compra sin pagar.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.sponsorPackagePurchase.update({ where: { id }, data: { status: 'CANCELED' } });
      if (row.campaignId) {
        await tx.sponsorCampaign.update({
          where: { id: row.campaignId },
          data: { status: 'ENDED' },
        });
      }
      await this.audit.record(
        {
          actorId,
          action: 'sponsor_package.purchase_canceled',
          entityType: 'sponsor_package_purchase',
          entityId: id,
          changes: {},
        },
        tx,
      );
    });
    return this.purchase(id);
  }

  private async purchase(id: string): Promise<PackagePurchaseDto> {
    return toPurchaseDto(
      await this.prisma.sponsorPackagePurchase.findUniqueOrThrow({
        where: { id },
        include: purchaseInclude,
      }),
    );
  }

  // ───────────── Aviso de pago ─────────────

  private async onPayment(
    tx: Tx,
    id: string,
    event: BillingPaymentEvent,
  ): Promise<AfterCommit | void> {
    const purchase = await tx.sponsorPackagePurchase.findUnique({ where: { id } });
    if (!purchase) return;
    const status =
      event.outcome === 'PAID' ? 'PAID' : event.outcome === 'FAILED' ? 'FAILED' : 'PENDING';
    await tx.billingCharge.upsert({
      where: {
        provider_providerPaymentId: {
          provider: this.gateway.provider,
          providerPaymentId: event.providerPaymentId,
        },
      },
      create: {
        purpose: 'SPONSOR_PACKAGE',
        sponsorPurchaseId: id,
        amount: event.amount,
        currency: event.currency,
        status,
        provider: this.gateway.provider,
        providerPaymentId: event.providerPaymentId,
        failureReason: event.failureReason,
        paidAt: status === 'PAID' ? new Date(this.clock.now()) : null,
      },
      update: { status, failureReason: event.failureReason },
    });
    if (status !== 'PAID' || purchase.status !== 'PENDING') return;
    if (event.amount !== purchase.priceAmount || event.currency !== purchase.currency) {
      this.logger.warn(`Pago de paquete ${id} con monto distinto: no se activa`);
      return;
    }
    await this.activate(tx, id);
  }

  /** Activa la campaña desde ahora por los días del paquete. */
  private async activate(tx: Tx, id: string): Promise<void> {
    const purchase = await tx.sponsorPackagePurchase.findUniqueOrThrow({
      where: { id },
      include: purchaseInclude,
    });
    const now = this.clock.now();
    await tx.sponsorPackagePurchase.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date(now) },
    });
    if (purchase.campaignId) {
      await tx.sponsorCampaign.update({
        where: { id: purchase.campaignId },
        data: {
          status: 'ACTIVE',
          startsAt: new Date(now),
          endsAt: new Date(now + purchase.package.durationDays * DAY_MS),
          impressionsLimit: purchase.package.impressionsLimit,
        },
      });
    }
    await this.audit.record(
      {
        actorId: null,
        action: 'sponsor_package.paid',
        entityType: 'sponsor_package_purchase',
        entityId: id,
        changes: {},
      },
      tx,
    );
  }
}

function toPackageDto(p: PackageRow): SponsorPackageDto {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    priceAmount: p.priceAmount,
    currency: p.currency,
    impressionsLimit: p.impressionsLimit,
    placementsLimit: p.placementsLimit,
    durationDays: p.durationDays,
    sortOrder: p.sortOrder,
    isActive: p.isActive,
  };
}

function toPurchaseDto(p: PurchaseRow): PackagePurchaseDto {
  return {
    id: p.id,
    sponsorId: p.sponsorId,
    package: toPackageDto(p.package),
    campaignId: p.campaignId,
    priceAmount: p.priceAmount,
    currency: p.currency,
    status: p.status,
    checkoutUrl: p.status === 'PENDING' ? p.checkoutUrl : null,
    paidAt: p.paidAt,
    createdAt: p.createdAt,
  };
}
