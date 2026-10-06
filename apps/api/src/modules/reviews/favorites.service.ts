import { Injectable } from '@nestjs/common';
import {
  DEFAULT_PAGE_SIZE,
  type Page,
  type PaginationQueryDto,
} from '../../common/pagination/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BarbershopAccessService, PUBLIC_STATUSES } from '../barbershops/barbershop-access.service';
import type { FavoriteDto } from './dto/favorite.dto';

/**
 * Favoritos (RF-FAV-001…003). Sin límite. Una barbería suspendida, pendiente de revisión o
 * eliminada desaparece de la lista, pero el favorito no se borra: vuelve si se reactiva.
 * Marcar y desmarcar son idempotentes.
 */
@Injectable()
export class FavoritesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BarbershopAccessService,
  ) {}

  /** RF-FAV-001: solo barberías visibles públicamente. */
  async add(userId: string, barbershopId: string): Promise<void> {
    await this.access.requirePublic(barbershopId);
    await this.prisma.favorite.createMany({
      data: [{ clientId: userId, barbershopId }],
      skipDuplicates: true,
    });
  }

  /** RF-FAV-002: desmarcar lo que no está marcado no es un error. */
  async remove(userId: string, barbershopId: string): Promise<void> {
    await this.prisma.favorite.deleteMany({ where: { clientId: userId, barbershopId } });
  }

  /**
   * Cuáles de estas barberías son favoritas de la cuenta: **una sola consulta** para toda la
   * página (búsqueda o ficha). Sin cuenta, ninguna.
   */
  async favoriteIds(userId: string | null, barbershopIds: string[]): Promise<Set<string>> {
    if (!userId || barbershopIds.length === 0) return new Set();
    const rows = await this.prisma.favorite.findMany({
      where: { clientId: userId, barbershopId: { in: barbershopIds } },
      select: { barbershopId: true },
    });
    return new Set(rows.map((r) => r.barbershopId));
  }

  /** RF-FAV-003: los más recientes primero. */
  async list(userId: string, query: PaginationQueryDto): Promise<Page<FavoriteDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const rows = await this.prisma.favorite.findMany({
      where: {
        clientId: userId,
        barbershop: { deletedAt: null, status: { in: PUBLIC_STATUSES } },
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: {
        barbershop: {
          select: {
            id: true,
            name: true,
            address: true,
            type: true,
            status: true,
            ratingAvg: true,
            ratingCount: true,
          },
        },
      },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((f) => ({
        barbershopId: f.barbershop.id,
        name: f.barbershop.name,
        address: f.barbershop.address,
        type: f.barbershop.type,
        status: f.barbershop.status,
        rating: { average: Number(f.barbershop.ratingAvg), count: f.barbershop.ratingCount },
        favoritedAt: f.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }
}
