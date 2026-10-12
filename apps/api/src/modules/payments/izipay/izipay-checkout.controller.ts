import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../../common/auth/public.decorator';
import { sendPage } from '../checkout-pages';
import { IzipayCheckoutService } from './izipay-checkout.service';
import { IZIPAY_CHECKOUT_ROUTE } from './izipay-gateway';

const uuid = new ParseUUIDPipe();

/**
 * Páginas del pago con Izipay que abre la app en un WebView (Fase 8B). No son parte del contrato
 * JSON: la app recibe la URL en `clientAction.data.paymentUrl`.
 */
@ApiExcludeController()
@Controller(IZIPAY_CHECKOUT_ROUTE)
export class IzipayCheckoutController {
  constructor(private readonly checkout: IzipayCheckoutService) {}

  @Public()
  @Get('checkout/:paymentId')
  async page(
    @Param('paymentId', uuid) paymentId: string,
    @Query('e') expires: unknown,
    @Query('s') signature: unknown,
    @Res() res: Response,
  ): Promise<void> {
    sendPage(res, await this.checkout.page(paymentId, expires, signature));
  }

  /** Izipay vuelve aquí por POST (x-www-form-urlencoded) al terminar el formulario. */
  @Public()
  @Post('return/:paymentId')
  async return(
    @Param('paymentId', uuid) paymentId: string,
    @Query('r') result: unknown,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(303, await this.checkout.handleReturn(paymentId, result, body ?? {}));
  }
}
