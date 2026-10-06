import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../../common/auth/public.decorator';
import { APP_CONFIG } from '../../../common/config/app-config.token';
import { type AppConfig, NodeEnv } from '../../../common/config/env.validation';
import { FakePaymentResultDto } from '../dto/payment.dto';
import { PaymentsModule } from '../payments.module';
import { PaymentsService } from '../payments.service';

/**
 * Solo pruebas: simula el resultado del pago que en la Fase 8 llegará por webhook verificado.
 * Doble protección: el módulo solo se registra con NODE_ENV=test (`testOnlyModules`) y, además,
 * la ruta responde 404 si la configuración no es de pruebas.
 */
@ApiExcludeController()
@Public()
@Controller('testing/payments')
export class PaymentsTestingController {
  constructor(
    private readonly payments: PaymentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':paymentId/result')
  @HttpCode(HttpStatus.OK)
  async result(
    @Param('paymentId', new ParseUUIDPipe()) paymentId: string,
    @Body() dto: FakePaymentResultDto,
  ): Promise<{ status: string }> {
    if (this.config.nodeEnv !== NodeEnv.Test) throw new NotFoundException();
    return { status: await this.payments.handleResult(paymentId, dto.outcome) };
  }
}

@Module({ imports: [PaymentsModule], controllers: [PaymentsTestingController] })
export class PaymentsTestingModule {}

/** Módulos que solo existen en el entorno de pruebas (nunca en desarrollo ni producción). */
export function testOnlyModules(nodeEnv: string | undefined): (typeof PaymentsTestingModule)[] {
  return nodeEnv === NodeEnv.Test ? [PaymentsTestingModule] : [];
}
