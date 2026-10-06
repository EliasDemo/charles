import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BarbershopAccessService, forbidden } from '../barbershops/barbershop-access.service';
import type { CreateBarbershopReportDto } from './dto/ticket.dto';

/**
 * Reportes de barberías (Fase 12): cualquier cuenta reporta una barbería visible, una vez, con
 * motivo de lista cerrada. Sus miembros no la reportan. Soporte los resuelve en `/admin`.
 */
@Injectable()
export class BarbershopReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
  ) {}

  async create(
    userId: string,
    barbershopId: string,
    dto: CreateBarbershopReportDto,
  ): Promise<void> {
    await this.access.requirePublic(barbershopId);
    if (await this.access.isMember(barbershopId, userId)) throw forbidden();
    try {
      await this.prisma.barbershopReport.create({
        data: {
          barbershopId,
          reportedById: userId,
          reason: dto.reason,
          details: dto.details ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(
          ErrorCode.ALREADY_REPORTED,
          'Ya reportaste esta barbería.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }
}
