import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../../common/auth/auth-user';
import { Public } from '../../common/auth/public.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import type { RequestWithRawBody } from '../../common/http/body-parsers';
import { SkipThrottle } from '@nestjs/throttler';
import { clientIpOf } from '../../common/throttling/client-ip-throttler.guard';
import { RateLimit } from '../../common/throttling/rate-limit.decorator';
import {
  PaymentStartDto,
  PaymentStatusDto,
  PaymentVerificationDto,
  WebhookReceiptDto,
} from './dto/payment.dto';
import { InvalidSignatureError, type RawWebhook } from './payment-gateway';
import { PaymentsService } from './payments.service';
import { PaymentVerificationService } from './payment-verification.service';
import { WebhooksService } from './webhooks.service';

const uuid = new ParseUUIDPipe();

function rawOf(req: RequestWithRawBody): RawWebhook {
  return { rawBody: req.rawBody ?? Buffer.alloc(0), headers: req.headers };
}

@ApiTags('payments')
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly webhooks: WebhooksService,
    private readonly verification: PaymentVerificationService,
  ) {}

  @ApiBearerAuth()
  @Post('bookings/:id/payment')
  @HttpCode(HttpStatus.OK)
  @RateLimit('payments')
  @ApiOperation({
    summary: 'RF-PAG-001: iniciar o reintentar el pago de una reserva pendiente (idempotente)',
  })
  @ApiOkResponse({ type: PaymentStartDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiBadGatewayResponse({ type: ErrorResponseDto })
  start(@CurrentUser() user: AuthUser, @Param('id', uuid) id: string): Promise<PaymentStartDto> {
    return this.payments.start(user.id, id);
  }

  @ApiBearerAuth()
  @Get('bookings/:id/payment')
  @ApiOperation({ summary: 'RF-PAG-002: estado del pago y de sus reembolsos (cliente)' })
  @ApiOkResponse({ type: PaymentStatusDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async status(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
  ): Promise<PaymentStatusDto> {
    return { items: await this.payments.statusOf(user.id, id) };
  }

  @ApiBearerAuth()
  @Post('bookings/:id/payment/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit('payments')
  @ApiOperation({
    summary: 'RF-PAG-002: la app reenvía el resultado firmado; el servidor consulta a la pasarela',
    description:
      'Verifica la firma del resultado que devuelve el SDK y, si es auténtico, consulta el estado ' +
      'del pago al proveedor. La respuesta de la app nunca confirma la reserva por sí sola.',
  })
  @ApiOkResponse({ type: PaymentVerificationDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  async verify(
    @CurrentUser() user: AuthUser,
    @Param('id', uuid) id: string,
    @Req() req: RequestWithRawBody,
  ): Promise<PaymentVerificationDto> {
    try {
      return await this.verification.verifyClientResult(user.id, id, rawOf(req));
    } catch (error) {
      if (error instanceof InvalidSignatureError) {
        throw new AppException(
          ErrorCode.INVALID_SIGNATURE,
          'Firma inválida.',
          HttpStatus.UNAUTHORIZED,
        );
      }
      throw error;
    }
  }

  @Public()
  @Post('payments/webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  // Sin límite global por IP: el proveedor envía desde pocas direcciones. Lo limita
  // WebhookRateLimiter (por proveedor los válidos, por IP los de firma inválida).
  @SkipThrottle()
  @ApiOperation({
    summary: 'RF-PAG-002: aviso firmado de la pasarela (IPN). Idempotente por evento.',
  })
  @ApiOkResponse({ type: WebhookReceiptDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  webhook(
    @Param('provider') provider: string,
    @Req() req: RequestWithRawBody,
  ): Promise<WebhookReceiptDto> {
    return this.webhooks.receive(provider, rawOf(req), clientIpOf(req));
  }
}
