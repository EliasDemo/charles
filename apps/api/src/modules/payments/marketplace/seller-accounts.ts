import { randomBytes } from 'node:crypto';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuditService } from '../../../common/audit/audit.service';
import { type AuthUser, CurrentUser } from '../../../common/auth/auth-user';
import { Public } from '../../../common/auth/public.decorator';
import { CLOCK, type Clock } from '../../../common/clock/clock';
import { APP_CONFIG } from '../../../common/config/app-config.token';
import type { AppConfig } from '../../../common/config/env.validation';
import { EncryptedField } from '../../../common/crypto/encryption-contexts';
import { EncryptionService } from '../../../common/crypto/encryption.service';
import { AppException } from '../../../common/errors/app.exception';
import { ErrorCode } from '../../../common/errors/error-codes';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { BarbershopAccessService } from '../../barbershops/barbershop-access.service';
import { messagePage, sendPage } from '../checkout-pages';
import { MERCADOPAGO_PROVIDER, MercadoPagoGateway } from '../mercadopago/mercadopago-gateway';
import { PAYMENT_GATEWAY, type PaymentGateway, type SellerCredentials } from '../payment-gateway';

/** Ruta pública (bajo /api/v1) a la que Mercado Pago devuelve tras autorizar. */
export const SELLER_OAUTH_CALLBACK_ROUTE = 'mercadopago/oauth/callback';
const STATE_TTL_MS = 30 * 60 * 1000;
/** Se renueva el token si vence en menos de esto (los de Mercado Pago duran 180 días). */
const REFRESH_MARGIN_MS = 7 * 24 * 3_600_000;
const HTTP_TIMEOUT_MS = 15_000;

/** Tokens que devuelve el proveedor al autorizar o renovar. */
export interface SellerTokens {
  accessToken: string;
  refreshToken: string | null;
  providerUserId: string;
  publicKey: string | null;
  expiresInSeconds: number | null;
}

/** Vinculación OAuth con la pasarela (Mercado Pago real o simulada). */
export interface SellerOAuthClient {
  authorizationUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<SellerTokens>;
  refresh(refreshToken: string): Promise<SellerTokens>;
}

/**
 * OAuth de Mercado Pago (Marketplace): `auth.mercadopago.com/authorization` y
 * `POST /oauth/token` (authorization_code y refresh_token). Ver la documentación de Mercado Pago:
 * "Marketplace → Integrar → OAuth".
 */
class MercadoPagoOAuthClient implements SellerOAuthClient {
  constructor(private readonly config: AppConfig) {}

  private get mp(): AppConfig['payments']['mercadoPago'] {
    return this.config.payments.mercadoPago;
  }

  private credentials(): { clientId: string; clientSecret: string } {
    const { clientId, clientSecret } = this.mp;
    if (!clientId || !clientSecret) {
      throw new AppException(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'Falta configurar MERCADOPAGO_CLIENT_ID y MERCADOPAGO_CLIENT_SECRET.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { clientId, clientSecret };
  }

  authorizationUrl(state: string, redirectUri: string): string {
    const query = new URLSearchParams({
      client_id: this.credentials().clientId,
      response_type: 'code',
      platform_id: 'mp',
      state,
      redirect_uri: redirectUri,
    });
    return `https://auth.mercadopago.com/authorization?${query.toString()}`;
  }

  exchangeCode(code: string, redirectUri: string): Promise<SellerTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<SellerTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async token(grant: Record<string, string>): Promise<SellerTokens> {
    const { clientId, clientSecret } = this.credentials();
    let res: globalThis.Response;
    try {
      res = await fetch(`${this.mp.apiUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...grant }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw providerError();
    }
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      user_id?: number | string;
      public_key?: string;
      expires_in?: number;
    } | null;
    if (!res.ok || !body?.access_token || body.user_id === undefined) throw providerError();
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      providerUserId: String(body.user_id),
      publicKey: body.public_key ?? null,
      expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : null,
    };
  }
}

/**
 * OAuth simulado (desarrollo, pruebas y demo): "autorizar" redirige directo al callback con un
 * código válido; los tokens son aleatorios y la cuenta se identifica por la barbería.
 */
export class FakeSellerOAuthClient implements SellerOAuthClient {
  authorizationUrl(state: string, redirectUri: string): string {
    return `${redirectUri}?code=fake-${state}&state=${state}`;
  }

  exchangeCode(code: string): Promise<SellerTokens> {
    if (!code.startsWith('fake-')) return Promise.reject(providerError());
    return Promise.resolve(fakeTokens());
  }

  refresh(): Promise<SellerTokens> {
    return Promise.resolve(fakeTokens());
  }
}

function fakeTokens(): SellerTokens {
  return {
    accessToken: `FAKE-SELLER-${randomBytes(12).toString('hex')}`,
    refreshToken: `FAKE-RT-${randomBytes(12).toString('hex')}`,
    providerUserId: String(100_000_000 + randomBytes(3).readUIntBE(0, 3)),
    publicKey: null,
    expiresInSeconds: 180 * 86_400,
  };
}

const providerError = (): AppException =>
  new AppException(
    ErrorCode.PAYMENT_PROVIDER_ERROR,
    'Mercado Pago no respondió. Inténtalo nuevamente.',
    HttpStatus.BAD_GATEWAY,
  );

export const SELLER_OAUTH_CLIENT = Symbol('SELLER_OAUTH_CLIENT');

export function sellerOAuthClientFactory(
  config: AppConfig,
  gateway: PaymentGateway,
): SellerOAuthClient {
  return gateway.provider === MERCADOPAGO_PROVIDER
    ? new MercadoPagoOAuthClient(config)
    : new FakeSellerOAuthClient();
}

// ───────────── DTOs ─────────────

export class SellerAccountDto {
  @ApiProperty({
    enum: ['NOT_CONNECTED', 'PENDING', 'CONNECTED', 'REVOKED'],
    description: 'CONNECTED: los pagos de reservas van directo a la cuenta de la barbería.',
  })
  status!: 'NOT_CONNECTED' | 'PENDING' | 'CONNECTED' | 'REVOKED';

  @ApiProperty({ example: 'MERCADOPAGO' })
  provider!: string;

  @ApiProperty({ type: String, nullable: true, description: 'ID de la cuenta en Mercado Pago.' })
  providerUserId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  connectedAt!: Date | null;
}

export class SellerConnectDto {
  @ApiProperty({
    description: 'Abrir en el navegador: el dueño autoriza en Mercado Pago y vuelve.',
  })
  authorizationUrl!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: Date;
}

// ───────────── Servicio ─────────────

/**
 * Cuentas de Mercado Pago de las barberías (Marketplace). Con la cuenta vinculada, el pago de
 * una reserva se cobra con el token de la barbería y Charles retiene su comisión
 * (`marketplace_fee`): el dinero llega directo a la barbería. Sin cuenta, se cobra con la cuenta
 * de Charles y queda como saldo por liquidar.
 *
 * Los tokens se guardan cifrados. Las llamadas a Mercado Pago ocurren fuera de transacciones.
 */
@Injectable()
export class SellerAccountsService implements OnModuleInit {
  private readonly logger = new Logger(SellerAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
    private readonly crypto: EncryptionService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(SELLER_OAUTH_CLIENT) private readonly oauth: SellerOAuthClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    if (this.gateway instanceof MercadoPagoGateway) {
      this.gateway.setSellerTokenResolver((id) => this.tokenForProviderUser(id));
    }
  }

  get provider(): string {
    return this.gateway.provider;
  }

  private redirectUri(): string {
    const base =
      this.config.payments.publicApiUrl ?? `http://localhost:${process.env.PORT ?? 3000}`;
    return `${base}/api/v1/${SELLER_OAUTH_CALLBACK_ROUTE}`;
  }

  async status(userId: string, barbershopId: string): Promise<SellerAccountDto> {
    await this.access.requireMember(userId, barbershopId);
    const account = await this.prisma.sellerAccount.findUnique({ where: { barbershopId } });
    if (!account) {
      return {
        status: 'NOT_CONNECTED',
        provider: this.provider,
        providerUserId: null,
        connectedAt: null,
      };
    }
    return {
      status: account.status,
      provider: account.provider,
      providerUserId: account.providerUserId,
      connectedAt: account.connectedAt,
    };
  }

  /** Solo el dueño: genera el enlace de autorización (válido 30 minutos). */
  async connect(userId: string, barbershopId: string): Promise<SellerConnectDto> {
    await this.access.requireMember(userId, barbershopId, ['OWNER']);
    const state = randomBytes(24).toString('base64url');
    const expiresAt = new Date(this.clock.now() + STATE_TTL_MS);
    const url = this.oauth.authorizationUrl(state, this.redirectUri());
    await this.prisma.sellerAccount.upsert({
      where: { barbershopId },
      create: {
        barbershopId,
        provider: this.provider,
        status: 'PENDING',
        oauthState: state,
        oauthStateExpiresAt: expiresAt,
      },
      update: { oauthState: state, oauthStateExpiresAt: expiresAt },
    });
    return { authorizationUrl: url, expiresAt };
  }

  /** Regreso de Mercado Pago: valida el `state`, canjea el código y guarda los tokens cifrados. */
  async completeAuthorization(code: string, state: string): Promise<{ barbershopId: string }> {
    const account = await this.prisma.sellerAccount.findUnique({ where: { oauthState: state } });
    if (
      !account ||
      !account.oauthStateExpiresAt ||
      account.oauthStateExpiresAt.getTime() < this.clock.now()
    ) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'El enlace de vinculación venció. Vuelve a intentarlo desde la app.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const tokens = await this.oauth.exchangeCode(code, this.redirectUri());
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.sellerAccount.update({
        where: { id: account.id },
        data: {
          provider: this.provider,
          status: 'CONNECTED',
          ...this.tokenData(tokens, now),
          oauthState: null,
          oauthStateExpiresAt: null,
          connectedAt: new Date(now),
        },
      });
      await this.audit.record(
        {
          actorId: null,
          action: 'seller_account.connected',
          entityType: 'barbershop',
          entityId: account.barbershopId,
          changes: { provider: this.provider, providerUserId: tokens.providerUserId },
        },
        tx,
      );
    });
    return { barbershopId: account.barbershopId };
  }

  /** Solo el dueño: desvincula. Los pagos nuevos vuelven a cobrarse con la cuenta de Charles. */
  async disconnect(userId: string, barbershopId: string): Promise<void> {
    await this.access.requireMember(userId, barbershopId, ['OWNER']);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.sellerAccount.updateMany({
        where: { barbershopId, status: { not: 'REVOKED' } },
        data: { status: 'REVOKED', oauthState: null, oauthStateExpiresAt: null },
      });
      if (count) {
        await this.audit.record(
          {
            actorId: userId,
            action: 'seller_account.revoked',
            entityType: 'barbershop',
            entityId: barbershopId,
          },
          tx,
        );
      }
    });
  }

  /** ¿Se cobra con la cuenta de la barbería? (dentro de la transacción de la reserva). */
  async isConnectedInTx(tx: Prisma.TransactionClient, barbershopId: string): Promise<boolean> {
    const account = await tx.sellerAccount.findUnique({
      where: { barbershopId },
      select: { status: true, provider: true },
    });
    return account?.status === 'CONNECTED' && account.provider === this.provider;
  }

  /**
   * Credenciales vigentes de la barbería (renueva el token si está por vencer). Fuera de
   * transacciones. null si no está vinculada o la renovación falla.
   */
  async credentialsFor(barbershopId: string): Promise<SellerCredentials | null> {
    const account = await this.prisma.sellerAccount.findUnique({ where: { barbershopId } });
    if (
      !account ||
      account.status !== 'CONNECTED' ||
      !account.accessTokenEnc ||
      !account.providerUserId
    ) {
      return null;
    }
    const expiring =
      account.tokenExpiresAt &&
      account.tokenExpiresAt.getTime() - this.clock.now() < REFRESH_MARGIN_MS;
    if (expiring && account.refreshTokenEnc) {
      try {
        const tokens = await this.oauth.refresh(
          this.crypto.decrypt(account.refreshTokenEnc, EncryptedField.SELLER_REFRESH_TOKEN),
        );
        await this.prisma.sellerAccount.update({
          where: { id: account.id },
          data: this.tokenData(tokens, this.clock.now()),
        });
        return { accessToken: tokens.accessToken, providerUserId: tokens.providerUserId };
      } catch {
        this.logger.warn(`No se pudo renovar el token de la barbería ${barbershopId}`);
        if (account.tokenExpiresAt!.getTime() <= this.clock.now()) return null;
      }
    }
    return {
      accessToken: this.crypto.decrypt(account.accessTokenEnc, EncryptedField.SELLER_ACCESS_TOKEN),
      providerUserId: account.providerUserId,
    };
  }

  /** Para los webhooks: token de la cuenta vinculada con ese ID de Mercado Pago. */
  async tokenForProviderUser(providerUserId: string): Promise<string | null> {
    const account = await this.prisma.sellerAccount.findFirst({
      where: { provider: this.provider, providerUserId, status: 'CONNECTED' },
      select: { barbershopId: true },
    });
    if (!account) return null;
    return (await this.credentialsFor(account.barbershopId))?.accessToken ?? null;
  }

  private tokenData(tokens: SellerTokens, now: number) {
    return {
      providerUserId: tokens.providerUserId,
      publicKey: tokens.publicKey,
      accessTokenEnc: this.crypto.encrypt(tokens.accessToken, EncryptedField.SELLER_ACCESS_TOKEN),
      refreshTokenEnc: tokens.refreshToken
        ? this.crypto.encrypt(tokens.refreshToken, EncryptedField.SELLER_REFRESH_TOKEN)
        : null,
      tokenExpiresAt: tokens.expiresInSeconds
        ? new Date(now + tokens.expiresInSeconds * 1000)
        : null,
    };
  }
}

// ───────────── Controladores ─────────────

@ApiTags('payments')
@ApiBearerAuth()
@Controller('barbershops/:id/seller-account')
export class SellerAccountsController {
  constructor(private readonly sellers: SellerAccountsService) {}

  @Get()
  @ApiOperation({ summary: 'Estado de la cuenta de Mercado Pago vinculada (cobro directo)' })
  @ApiOkResponse({ type: SellerAccountDto })
  status(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SellerAccountDto> {
    return this.sellers.status(user.id, id);
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'OWNER: enlace para vincular la cuenta de Mercado Pago de la barbería' })
  @ApiOkResponse({ type: SellerConnectDto })
  connect(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SellerConnectDto> {
    return this.sellers.connect(user.id, id);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'OWNER: desvincular (los pagos vuelven a la cuenta de Charles)' })
  @ApiNoContentResponse()
  disconnect(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    return this.sellers.disconnect(user.id, id);
  }
}

/** Regreso del OAuth: página simple que le dice al dueño que vuelva a la app. */
@Controller(SELLER_OAUTH_CALLBACK_ROUTE)
export class SellerOAuthCallbackController {
  constructor(private readonly sellers: SellerAccountsService) {}

  @Public()
  @Get()
  @ApiExcludeEndpoint()
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Res() res: Response,
  ): Promise<void> {
    if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
      sendPage(
        res,
        messagePage(
          400,
          'Vinculación cancelada',
          'No se vinculó la cuenta. Vuelve a la app e inténtalo de nuevo.',
        ),
      );
      return;
    }
    try {
      await this.sellers.completeAuthorization(code, state);
      sendPage(
        res,
        messagePage(
          200,
          'Cuenta vinculada',
          'Tu cuenta de Mercado Pago quedó vinculada a Charles. Ya puedes volver a la app.',
        ),
      );
    } catch (error) {
      const text =
        error instanceof AppException
          ? error.message
          : 'No pudimos vincular la cuenta. Inténtalo de nuevo.';
      sendPage(res, messagePage(400, 'No se pudo vincular', text));
    }
  }
}
