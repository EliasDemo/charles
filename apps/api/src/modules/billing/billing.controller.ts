import { Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import type { RequestWithRawBody } from '../../common/http/body-parsers';
import { WebhookReceiptDto } from '../payments/dto/payment.dto';
import { BillingWebhooksService } from './billing-webhooks.service';

/** Avisos firmados de la pasarela de facturación (planes, membresías y paquetes). */
@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly webhooks: BillingWebhooksService) {}

  @Public()
  @Post('webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  @ApiOperation({ summary: 'Aviso firmado de la pasarela de facturación. Idempotente por evento.' })
  @ApiOkResponse({ type: WebhookReceiptDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  webhook(
    @Param('provider') provider: string,
    @Req() req: RequestWithRawBody,
  ): Promise<WebhookReceiptDto> {
    return this.webhooks.receive(provider, {
      rawBody: req.rawBody ?? Buffer.alloc(0),
      headers: req.headers,
    });
  }
}
