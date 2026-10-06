import { FavoritesService } from '../reviews/favorites.service';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  type AvailabilityRequest,
  AvailabilityService,
  availabilityKey,
} from '../availability/availability.service';
import type { Slot } from '../availability/engine/compute-slots';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { SERVICE_CURRENCY } from '../services/dto/service.dto';
import { ServicesService } from '../services/services.service';
import { SettingKey, SettingsService } from '../settings/settings.service';
import type {
  AlternativeDto,
  AlternativesDto,
  AlternativesQueryDto,
  SearchPageDto,
  SearchQueryDto,
  SearchResultDto,
} from './dto/search.dto';
import {
  type Candidate,
  type OrderKey,
  RANKING_STRATEGY,
  type RankingStrategy,
  type SearchSort,
} from './ranking/ranking';
import { SearchCursor } from './search-cursor';
import { type CandidateFilters, SearchRepository } from './search.repository';

export const SEARCH_DEFAULTS = {
  defaultRadiusKm: 5,
  maxRadiusKm: 25,
  defaultPageSize: 20,
  maxPageSize: 50,
  maxCandidates: 200,
} as const;

/** RF-BUS-004: máximo de alternativas devueltas (sin paginación). */
export const MAX_ALTERNATIVES = 5;
/** Barberías pedidas a la base por tanda cuando hay que evaluar disponibilidad. */
const MIN_BATCH = 25;

type SearchSettings = { -readonly [K in keyof typeof SEARCH_DEFAULTS]: number };

/** Disponibilidad ya calculada de una barbería (se reutiliza para la respuesta). */
interface Evaluation {
  isOpenNow?: boolean;
  availableNow?: boolean;
  onDate?: boolean;
}

const invalid = (field: string, constraint: string): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: [constraint] }],
  );

const notFound = (message: string): AppException =>
  new AppException(ErrorCode.NOT_FOUND, message, HttpStatus.NOT_FOUND);

/**
 * Búsqueda de barberías (RF-BUS-001…004). La base filtra por visibilidad, cercanía, texto,
 * categoría, precio, valoración y tipo; la disponibilidad se calcula por lotes con el motor de la
 * Fase 5. El orden lo define el componente de ranking (destacados en la Fase 13).
 *
 * Privacidad: la ubicación del cliente solo vive en esta petición. No se guarda, no se registra y
 * no viaja en el cursor (cifrado).
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly repository: SearchRepository,
    private readonly availability: AvailabilityService,
    private readonly access: BarbershopAccessService,
    private readonly services: ServicesService,
    private readonly settings: SettingsService,
    private readonly cursor: SearchCursor,
    @Inject(RANKING_STRATEGY) private readonly ranking: RankingStrategy,
    private readonly favorites: FavoritesService,
  ) {}

  async search(query: SearchQueryDto, viewerId: string | null = null): Promise<SearchPageDto> {
    const hasLocation = this.validate(query);
    const settings = await this.loadSettings();
    if (query.category && !(await this.services.findActiveCategoryId(query.category))) {
      throw invalid('category', 'activeCategory');
    }

    const sort: SearchSort = query.sort ?? (hasLocation ? 'distance' : 'rating');
    const order = this.ranking.orderKeys(sort);
    const after = query.cursor ? this.cursor.decode(query.cursor, sort, order.length) : null;
    const limit = Math.min(query.limit ?? settings.defaultPageSize, settings.maxPageSize);
    const filters: CandidateFilters = {
      origin:
        query.lat !== undefined && query.lng !== undefined
          ? {
              lat: query.lat,
              lng: query.lng,
              radiusMeters:
                Math.min(query.radiusKm ?? settings.defaultRadiusKm, settings.maxRadiusKm) * 1000,
            }
          : undefined,
      text: query.q,
      categoryKey: query.category,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      minRating: query.minRating,
      type: query.type,
    };

    const needsAvailability = !!(query.openNow || query.availableNow || query.date);
    const result = needsAvailability
      ? await this.scan(filters, order, after, limit, settings.maxCandidates, (batch) =>
          this.evaluate(batch, query),
        )
      : await this.page(filters, order, after, limit);

    const items = await this.toResults(
      result.items,
      result.evaluations,
      !query.cursor,
      sort,
      viewerId,
    );
    return {
      items,
      nextCursor: result.next ? this.cursor.encode(sort, result.next) : null,
      evaluationLimitReached: result.limitReached,
    };
  }

  /** RF-BUS-004: barberías cercanas a la consultada, con la misma categoría y turnos reales. */
  async alternatives(barbershopId: string, query: AlternativesQueryDto): Promise<AlternativesDto> {
    const origin = await this.access.publicLocation(barbershopId);
    if (!origin) throw notFound('La barbería no existe.');
    const service = (await this.services.bookableSummaries([query.serviceId])).get(query.serviceId);
    if (!service || service.barbershopId !== barbershopId) {
      throw notFound('El servicio no existe o no está disponible en esta barbería.');
    }
    const date = query.date ?? this.availability.todayIn(origin.timezone);
    if (!isRealDate(date)) throw invalid('date', 'isDate');

    const settings = await this.loadSettings();
    const filters: CandidateFilters = {
      origin: {
        lat: origin.latitude,
        lng: origin.longitude,
        radiusMeters: settings.maxRadiusKm * 1000,
      },
      categoryKey: service.categoryKey,
      excludeBarbershopId: barbershopId,
    };
    const firstSlots = new Map<string, { serviceId: string; slot: Slot }>();
    const result = await this.scan(
      filters,
      this.ranking.orderKeys('distance'),
      null,
      MAX_ALTERNATIVES,
      settings.maxCandidates,
      async (batch) => {
        const slots = await this.availability.availableOnDateBatch(requestsFor(batch), date);
        const evaluations = new Map<string, Evaluation>();
        for (const candidate of batch) {
          // Servicio con el turno más temprano; a igualdad, el más barato (vienen por precio).
          let best: { serviceId: string; slot: Slot } | null = null;
          for (const serviceId of candidate.serviceIds) {
            const slot = slots.get(availabilityKey({ barbershopId: candidate.id, serviceId }));
            if (slot && (!best || slot.start < best.slot.start)) best = { serviceId, slot };
          }
          if (best) firstSlots.set(candidate.id, best);
          evaluations.set(candidate.id, { onDate: !!best });
        }
        return evaluations;
      },
    );

    // Alternativas: sin personalizar (es una sugerencia, no una lista de la cuenta).
    const ranked = await this.toResults(result.items, result.evaluations, true, 'distance', null);
    const chosen = [...firstSlots.values()].map((f) => f.serviceId);
    const summaries = await this.services.bookableSummaries(chosen);
    const items: AlternativeDto[] = [];
    for (const barbershop of ranked) {
      const first = firstSlots.get(barbershop.id);
      const summary = first && summaries.get(first.serviceId);
      if (!first || !summary) continue;
      items.push({
        barbershop,
        service: {
          id: summary.id,
          name: summary.name,
          price: { amount: summary.priceAmount, currency: summary.currency },
          durationMinutes: summary.durationMinutes,
        },
        firstSlot: { startAt: new Date(first.slot.start), endAt: new Date(first.slot.end) },
      });
    }
    return { date, categoryKey: service.categoryKey, items };
  }

  // ───────────── Paginación ─────────────

  /** Sin filtros de disponibilidad: una sola consulta con un elemento de más. */
  private async page(
    filters: CandidateFilters,
    order: OrderKey[],
    after: (number | string)[] | null,
    limit: number,
  ): Promise<ScanResult> {
    const rows = await this.repository.candidates(filters, order, after, limit + 1);
    const items = rows.slice(0, limit);
    return {
      items,
      evaluations: new Map(),
      next: rows.length > limit ? (items[items.length - 1]?.sortValues ?? null) : null,
      limitReached: false,
    };
  }

  /**
   * Con filtros que exigen calcular disponibilidad: recorre candidatos en orden, por tandas,
   * hasta llenar la página o evaluar `maxCandidates`. Si llega al tope, devuelve lo encontrado
   * con el cursor del último evaluado.
   */
  private async scan(
    filters: CandidateFilters,
    order: OrderKey[],
    after: (number | string)[] | null,
    limit: number,
    maxCandidates: number,
    evaluate: (batch: Candidate[]) => Promise<Map<string, Evaluation>>,
  ): Promise<ScanResult> {
    const items: Candidate[] = [];
    const evaluations = new Map<string, Evaluation>();
    let cursor = after;
    let evaluated = 0;
    let exhausted = false;

    while (items.length < limit && evaluated < maxCandidates && !exhausted) {
      const take = Math.min(Math.max(limit * 2, MIN_BATCH), maxCandidates - evaluated);
      const batch = await this.repository.candidates(filters, order, cursor, take);
      const results = batch.length ? await evaluate(batch) : new Map<string, Evaluation>();
      let consumed = 0;
      for (const candidate of batch) {
        consumed++;
        evaluated++;
        cursor = candidate.sortValues;
        const evaluation = results.get(candidate.id);
        if (evaluation && passes(evaluation)) {
          items.push(candidate);
          evaluations.set(candidate.id, evaluation);
          if (items.length === limit) break;
        }
      }
      exhausted = batch.length < take && consumed === batch.length;
    }

    return {
      items,
      evaluations,
      next: exhausted ? null : cursor,
      limitReached: !exhausted && items.length < limit && evaluated >= maxCandidates,
    };
  }

  /** Disponibilidad pedida por los filtros, por lotes (una barbería pasa si cumple todos). */
  private async evaluate(
    batch: Candidate[],
    query: SearchQueryDto,
  ): Promise<Map<string, Evaluation>> {
    const ids = batch.map((c) => c.id);
    const requests = requestsFor(batch);
    const [openNow, now, onDate] = await Promise.all([
      query.openNow ? this.availability.openNowBatch(ids) : null,
      query.availableNow ? this.availability.availableNowBatch(requests) : null,
      query.date ? this.availability.availableOnDateBatch(requests, query.date) : null,
    ]);
    const evaluations = new Map<string, Evaluation>();
    for (const candidate of batch) {
      const anySlot = (slots: Map<string, Slot | null>): boolean =>
        candidate.serviceIds.some(
          (serviceId) => !!slots.get(availabilityKey({ barbershopId: candidate.id, serviceId })),
        );
      evaluations.set(candidate.id, {
        isOpenNow: openNow ? (openNow.get(candidate.id) ?? false) : undefined,
        availableNow: now ? anySlot(now) : undefined,
        onDate: onDate ? anySlot(onDate) : undefined,
      });
    }
    return evaluations;
  }

  // ───────────── Respuesta ─────────────

  /** Ranking (orden final y destacados) y datos de "abierta / disponible ahora" de la página. */
  private async toResults(
    page: Candidate[],
    evaluations: Map<string, Evaluation>,
    firstPage: boolean,
    sort: SearchSort,
    viewerId: string | null,
  ): Promise<SearchResultDto[]> {
    const ranked = await this.ranking.arrange(page, { sort, firstPage });
    const candidates = ranked.map((r) => r.candidate);
    // Una sola consulta de favoritos para toda la página.
    const favorites = await this.favorites.favoriteIds(
      viewerId,
      candidates.map((c) => c.id),
    );
    const missingOpen = candidates.filter((c) => evaluations.get(c.id)?.isOpenNow === undefined);
    const missingNow = candidates.filter((c) => evaluations.get(c.id)?.availableNow === undefined);
    const [openNow, now] = await Promise.all([
      missingOpen.length
        ? this.availability.openNowBatch(missingOpen.map((c) => c.id))
        : new Map<string, boolean>(),
      missingNow.length
        ? this.availability.availableNowBatch(requestsFor(missingNow))
        : new Map<string, Slot | null>(),
    ]);

    return ranked.map(({ candidate: c, featured }) => {
      const evaluation = evaluations.get(c.id);
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        status: c.status,
        address: c.address,
        latitude: c.latitude,
        longitude: c.longitude,
        rating: { average: c.ratingAverage, count: c.ratingCount },
        isFavorite: favorites.has(c.id),
        timezone: c.timezone,
        distanceMeters: c.distanceMeters,
        priceFrom: c.minPrice === null ? null : { amount: c.minPrice, currency: SERVICE_CURRENCY },
        isOpenNow: evaluation?.isOpenNow ?? openNow.get(c.id) ?? false,
        availableNow:
          evaluation?.availableNow ??
          c.serviceIds.some(
            (serviceId) => !!now.get(availabilityKey({ barbershopId: c.id, serviceId })),
          ),
        featured,
      };
    });
  }

  // ───────────── Validación y ajustes ─────────────

  /** Reglas entre parámetros. Devuelve si la búsqueda tiene ubicación. */
  private validate(query: SearchQueryDto): boolean {
    const hasLat = query.lat !== undefined;
    const hasLng = query.lng !== undefined;
    if (hasLat !== hasLng) throw invalid(hasLat ? 'lng' : 'lat', 'locationPair');
    if (!hasLat && query.radiusKm !== undefined) throw invalid('radiusKm', 'requiresLocation');
    if (!hasLat && query.sort === 'distance') throw invalid('sort', 'requiresLocation');
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw invalid('maxPrice', 'gteMinPrice');
    }
    if (query.date !== undefined && !isRealDate(query.date)) throw invalid('date', 'isDate');
    return hasLat;
  }

  private async loadSettings(): Promise<SearchSettings> {
    const [defaultRadiusKm, maxRadiusKm, defaultPageSize, maxPageSize, maxCandidates] =
      await Promise.all([
        this.settings.positiveInt(
          SettingKey.SEARCH_DEFAULT_RADIUS_KM,
          SEARCH_DEFAULTS.defaultRadiusKm,
        ),
        this.settings.positiveInt(SettingKey.SEARCH_MAX_RADIUS_KM, SEARCH_DEFAULTS.maxRadiusKm),
        this.settings.positiveInt(
          SettingKey.SEARCH_DEFAULT_PAGE_SIZE,
          SEARCH_DEFAULTS.defaultPageSize,
        ),
        this.settings.positiveInt(SettingKey.SEARCH_MAX_PAGE_SIZE, SEARCH_DEFAULTS.maxPageSize),
        this.settings.positiveInt(SettingKey.SEARCH_MAX_CANDIDATES, SEARCH_DEFAULTS.maxCandidates),
      ]);
    return {
      defaultRadiusKm: Math.min(defaultRadiusKm, maxRadiusKm),
      maxRadiusKm,
      defaultPageSize: Math.min(defaultPageSize, maxPageSize),
      maxPageSize,
      maxCandidates,
    };
  }
}

interface ScanResult {
  items: Candidate[];
  evaluations: Map<string, Evaluation>;
  next: (number | string)[] | null;
  limitReached: boolean;
}

/** Una barbería pasa si cumple todos los filtros de disponibilidad evaluados. */
function passes(evaluation: Evaluation): boolean {
  return (
    evaluation.isOpenNow !== false &&
    evaluation.availableNow !== false &&
    evaluation.onDate !== false
  );
}

function requestsFor(candidates: Candidate[]): AvailabilityRequest[] {
  return candidates.flatMap((c) =>
    c.serviceIds.map((serviceId) => ({ barbershopId: c.id, serviceId })),
  );
}

function isRealDate(date: string): boolean {
  return DateTime.fromISO(date, { zone: 'UTC' }).isValid;
}
