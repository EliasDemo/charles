import type { NestExpressApplication } from '@nestjs/platform-express';
import { DateTime } from 'luxon';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import {
  SEARCH_RATE_LIMIT,
  SEARCH_RATE_LIMIT_DEFAULT,
} from '../../src/common/throttling/rate-limit.decorator';
import { SearchRateLimitRefresher } from '../../src/modules/search/search-rate-limit';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { shopPayload } from '../support/barbershops';

const API = '/api/v1';
const SHOPS = `${API}/barbershops`;
const SEARCH = `${API}/search/barbershops`;
const LIMA = 'America/Lima';
const MONDAY = '2030-01-07';
const TUESDAY = '2030-01-08';

const lima = (date: string, hhmm: string) =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: LIMA }).toMillis();

/** Zonas separadas para que cada grupo de pruebas no interfiera con los demás. */
const AREA = {
  lima: { lat: -12.05, lng: -77.04 },
  piura: { lat: -5.19, lng: -80.63 },
  arequipa: { lat: -16.4, lng: -71.54 },
  cusco: { lat: -13.53, lng: -71.97 },
  trujillo: { lat: -8.11, lng: -79.03 },
} as const;
type Area = keyof typeof AREA;

interface ServiceSpec {
  name: string;
  category: string;
  price: number;
  available?: boolean;
  deleted?: boolean;
}

interface ShopSpec {
  name: string;
  area: Area;
  /** Desplazamiento al norte, en grados de latitud (0.009 ≈ 1 km). */
  north?: number;
  services?: ServiceSpec[];
  /** Horario del lunes; sin horario la barbería no tiene turnos. */
  monday?: { start: string; end: string };
  barber?: boolean;
  rating?: { average: number; count: number };
  status?: 'TEMPORARILY_CLOSED' | 'PENDING_REVIEW' | 'SUSPENDED' | 'DELETED';
}

interface SearchItem {
  id: string;
  name: string;
  type: string;
  status: string;
  rating: { average: number | null; count: number };
  distanceMeters: number | null;
  priceFrom: { amount: number; currency: string } | null;
  isOpenNow: boolean;
  availableNow: boolean;
  featured: boolean;
}

describe('RF-BUS-001…004 Búsqueda, cercanía, filtros y alternativas (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  const clock = { now: () => lima(MONDAY, '10:00') };
  const ids: Record<string, string> = {};
  const serviceIds: Record<string, string> = {};

  /** Cliente nuevo (IP propia) por petición: el límite de peticiones no interfiere. */
  const api = () => new AuthClient(app);
  const query = (params: Record<string, string | number | boolean | undefined>) =>
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
  const search = (params: Record<string, string | number | boolean | undefined>) =>
    api().get(`${SEARCH}?${query(params)}`);
  const near = (area: Area, extra: Record<string, string | number | boolean | undefined> = {}) =>
    search({ lat: AREA[area].lat, lng: AREA[area].lng, ...extra });
  const names = (res: { body: { items: SearchItem[] } }) => res.body.items.map((i) => i.name);

  async function createShop(spec: ShopSpec, token = ownerToken): Promise<string> {
    const { lat, lng } = AREA[spec.area];
    const res = await api()
      .post(
        SHOPS,
        shopPayload({ name: spec.name, latitude: lat + (spec.north ?? 0), longitude: lng }),
        token,
      )
      .expect(201);
    const id = res.body.id as string;
    await configureShop(id, spec, token);
    return id;
  }

  async function configureShop(id: string, spec: ShopSpec, token = ownerToken): Promise<void> {
    const bookable: string[] = [];
    for (const service of spec.services ?? []) {
      const created = await api()
        .post(
          `${SHOPS}/${id}/services`,
          {
            name: service.name,
            categoryKey: service.category,
            priceAmount: service.price,
            durationMinutes: 30,
            isAvailable: service.available ?? true,
          },
          token,
        )
        .expect(201);
      serviceIds[`${spec.name}/${service.name}`] = created.body.id;
      if (service.deleted) {
        await api().delete(`${SHOPS}/${id}/services/${created.body.id}`, token).expect(204);
      } else if (service.available !== false) {
        bookable.push(created.body.id);
      }
    }
    if (spec.barber) {
      await api()
        .post(`${SHOPS}/${id}/barbers`, { displayName: 'Barbero', serviceIds: bookable }, token)
        .expect(201);
    }
    if (spec.monday) {
      await api()
        .put(
          `${SHOPS}/${id}/business-hours`,
          { days: [{ dayOfWeek: 1, windows: [spec.monday] }] },
          token,
        )
        .expect(200);
    }
    if (spec.rating) {
      await prisma.barbershop.update({
        where: { id },
        data: { ratingAvg: spec.rating.average, ratingCount: spec.rating.count },
      });
    }
    if (spec.status === 'TEMPORARILY_CLOSED') {
      await api()
        .patch(`${SHOPS}/${id}/status`, { status: 'TEMPORARILY_CLOSED' }, token)
        .expect(200);
    } else if (spec.status === 'DELETED') {
      await api().delete(`${SHOPS}/${id}`, token).expect(204);
    } else if (spec.status) {
      await prisma.barbershop.update({ where: { id }, data: { status: spec.status } });
    }
    ids[spec.name] = id;
  }

  const MORNING = { start: '09:00', end: '13:00' };
  const AFTERNOON = { start: '15:00', end: '19:00' };
  const haircut = (price = 2500, name = 'Corte'): ServiceSpec => ({
    name,
    category: 'haircut',
    price,
  });

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    ownerToken = (await new AuthClient(app).newUser()).tokens.accessToken;

    // Lima: distancias conocidas desde AREA.lima.
    await createShop({ name: 'Lima A', area: 'lima', north: 0.009, services: [haircut()] });
    await createShop({ name: 'Lima B', area: 'lima', north: 0.027, services: [haircut()] });
    await createShop({ name: 'Lima C', area: 'lima', north: 0.054, services: [haircut()] });
    await createShop({ name: 'Lima D', area: 'lima', north: 0.27, services: [haircut()] });

    // Piura: texto, categoría, precio, valoración, tipo y orden.
    await createShop({
      name: 'Barbería Ñandú',
      area: 'piura',
      north: 0.001,
      services: [
        haircut(3000, 'Corte clásico'),
        { name: 'Perfilado', category: 'beard', price: 1500 },
      ],
      rating: { average: 4.8, count: 25 },
    });
    await createShop({
      name: 'BARBERIA CENTRAL',
      area: 'piura',
      north: 0.002,
      services: [haircut(2000, 'Degradé')],
      rating: { average: 4.2, count: 10 },
    });
    await createShop({
      name: 'Estilo Norte',
      area: 'piura',
      north: 0.003,
      services: [{ name: 'Tinte', category: 'hair_color', price: 6000 }],
    });
    await createShop({ name: 'Salón Vacío', area: 'piura', north: 0.004 });
    await createShop({
      name: 'Barbería Oculta',
      area: 'piura',
      north: 0.005,
      services: [
        { ...haircut(1000, 'Corte borrado'), deleted: true },
        { name: 'Barba', category: 'beard', price: 1000, available: false },
      ],
      rating: { average: 3, count: 3 },
    });
    // Barbero independiente (otra cuenta: un barbero activo en una sola barbería).
    const independent = await new AuthClient(app).newUser();
    const created = await api()
      .post(
        `${SHOPS}/independent`,
        shopPayload({
          name: 'Juan Barber',
          latitude: AREA.piura.lat + 0.006,
          longitude: AREA.piura.lng,
        }),
        independent.tokens.accessToken,
      )
      .expect(201);
    await configureShop(
      created.body.id,
      {
        name: 'Juan Barber',
        area: 'piura',
        services: [haircut(2500)],
        rating: { average: 4.8, count: 5 },
      },
      independent.tokens.accessToken,
    );

    // Arequipa: disponibilidad (reloj fijo: lunes 10:00 en Lima).
    const ready = { services: [haircut()], barber: true };
    await createShop({ name: 'AQP 1', area: 'arequipa', north: 0.009, ...ready, monday: MORNING });
    await createShop({
      name: 'AQP 2',
      area: 'arequipa',
      north: 0.018,
      ...ready,
      monday: AFTERNOON,
    });
    await createShop({
      name: 'AQP 3',
      area: 'arequipa',
      north: 0.027,
      services: [haircut()],
      monday: MORNING,
    });
    await createShop({
      name: 'AQP 4',
      area: 'arequipa',
      north: 0.036,
      ...ready,
      monday: MORNING,
      status: 'TEMPORARILY_CLOSED',
    });

    // Cusco: visibilidad.
    await createShop({ name: 'Cusco visible', area: 'cusco', north: 0.001 });
    await createShop({
      name: 'Cusco cerrada',
      area: 'cusco',
      north: 0.002,
      status: 'TEMPORARILY_CLOSED',
    });
    await createShop({
      name: 'Cusco revisión',
      area: 'cusco',
      north: 0.003,
      status: 'PENDING_REVIEW',
    });
    await createShop({
      name: 'Cusco suspendida',
      area: 'cusco',
      north: 0.004,
      status: 'SUSPENDED',
    });
    await createShop({ name: 'Cusco eliminada', area: 'cusco', north: 0.005, status: 'DELETED' });

    // Trujillo: alternativas (RF-BUS-004).
    await createShop({ name: 'TRU origen', area: 'trujillo', services: [haircut()], barber: true });
    await createShop({ name: 'TRU 1', area: 'trujillo', north: 0.009, ...ready, monday: MORNING });
    await createShop({
      name: 'TRU 2',
      area: 'trujillo',
      north: 0.018,
      services: [{ name: 'Barba', category: 'beard', price: 1500 }],
      barber: true,
      monday: MORNING,
    });
    await createShop({ name: 'TRU 3', area: 'trujillo', north: 0.027, ...ready });
    await createShop({
      name: 'TRU lejos',
      area: 'trujillo',
      north: 0.3,
      ...ready,
      monday: MORNING,
    });
    await createShop({
      name: 'TRU 5',
      area: 'trujillo',
      north: 0.036,
      services: [{ ...haircut(), available: false }],
      barber: true,
      monday: MORNING,
    });
    await createShop({
      name: 'TRU 6',
      area: 'trujillo',
      north: 0.045,
      services: [haircut(5000, 'Corte premium'), haircut(2000, 'Corte simple')],
      barber: true,
      monday: MORNING,
    });
  }, 120_000);
  afterAll(() => app.close());

  describe('RF-BUS-002 cercanía', () => {
    it('RF-BUS-002 radio por defecto de 5 km, más cercanas primero, con distancia en metros', async () => {
      const res = await near('lima').expect(200);
      expect(names(res)).toEqual(['Lima A', 'Lima B']);
      const [a, b] = res.body.items as SearchItem[];
      expect(a!.distanceMeters).toBeGreaterThan(950);
      expect(a!.distanceMeters).toBeLessThan(1050);
      expect(b!.distanceMeters).toBeGreaterThan(2900);
      expect(b!.distanceMeters).toBeLessThan(3100);
    });

    it('RF-BUS-002 borde del radio: incluye la barbería a la distancia exacta y excluye la que queda fuera', async () => {
      const all = await near('lima', { radiusKm: 25 }).expect(200);
      const b = (all.body.items as SearchItem[]).find((i) => i.name === 'Lima B')!;
      const meters = b.distanceMeters!;
      expect(names(await near('lima', { radiusKm: (meters + 5) / 1000 }).expect(200))).toEqual([
        'Lima A',
        'Lima B',
      ]);
      expect(names(await near('lima', { radiusKm: (meters - 5) / 1000 }).expect(200))).toEqual([
        'Lima A',
      ]);
    });

    it('RF-BUS-002 un radio mayor que el máximo (25 km) se recorta: no aparece la de 30 km', async () => {
      const res = await near('lima', { radiusKm: 500 }).expect(200);
      expect(names(res)).toEqual(['Lima A', 'Lima B', 'Lima C']);
    });

    it('sin ubicación no hay distancia y el orden por defecto es por valoración', async () => {
      const res = await search({ q: 'barberia' }).expect(200);
      expect(names(res)).toEqual(['Barbería Ñandú', 'BARBERIA CENTRAL', 'Barbería Oculta']);
      expect((res.body.items as SearchItem[]).every((i) => i.distanceMeters === null)).toBe(true);
    });
  });

  describe('RF-BUS-001 visibilidad', () => {
    it('RF-BUS-001 solo barberías visibles: ni en revisión, ni suspendidas, ni eliminadas', async () => {
      const res = await near('cusco').expect(200);
      expect(names(res)).toEqual(['Cusco visible', 'Cusco cerrada']);
      expect((res.body.items as SearchItem[])[1]).toMatchObject({
        status: 'TEMPORARILY_CLOSED',
        isOpenNow: false,
        availableNow: false,
      });
    });
  });

  describe('RF-BUS-001 texto', () => {
    it('RF-BUS-001 sin distinguir tildes ni mayúsculas, en el nombre de la barbería', async () => {
      expect(names(await near('piura', { q: 'BARBERÍA' }).expect(200))).toEqual([
        'Barbería Ñandú',
        'BARBERIA CENTRAL',
        'Barbería Oculta',
      ]);
      expect(names(await near('piura', { q: 'nandu' }).expect(200))).toEqual(['Barbería Ñandú']);
    });

    it('RF-BUS-001 también en el nombre de un servicio reservable', async () => {
      expect(names(await near('piura', { q: 'degrade' }).expect(200))).toEqual([
        'BARBERIA CENTRAL',
      ]);
      expect(names(await near('piura', { q: 'tinte' }).expect(200))).toEqual(['Estilo Norte']);
      // Un servicio eliminado no cuenta.
      expect(names(await near('piura', { q: 'borrado' }).expect(200))).toEqual([]);
    });

    it('los comodines de LIKE se buscan literalmente (consulta parametrizada)', async () => {
      expect(names(await near('piura', { q: '%_' }).expect(200))).toEqual([]);
      expect(names(await near('piura', { q: "' OR 1=1 --" }).expect(200))).toEqual([]);
    });

    it.each([
      ['1 carácter', 'a'],
      ['más de 80 caracteres', 'x'.repeat(81)],
      ['solo espacios', '   '],
    ])('rechaza texto de %s', async (_case, q) => {
      const res = await near('piura', { q }).expect(400);
      expect(res.body.details).toEqual([{ field: 'q', constraints: ['isLength'] }]);
    });
  });

  describe('RF-BUS-003 filtros', () => {
    it('RF-BUS-003 por categoría (clave): solo con un servicio reservable de esa categoría', async () => {
      expect(names(await near('piura', { category: 'haircut' }).expect(200))).toEqual([
        'Barbería Ñandú',
        'BARBERIA CENTRAL',
        'Juan Barber',
      ]);
      expect(names(await near('piura', { category: 'beard' }).expect(200))).toEqual([
        'Barbería Ñandú',
      ]);
    });

    it('RF-BUS-003 categoría inexistente o con formato inválido: 400', async () => {
      const res = await near('piura', { category: 'no_existe' }).expect(400);
      expect(res.body.details).toEqual([{ field: 'category', constraints: ['activeCategory'] }]);
      await near('piura', { category: 'Corte!' }).expect(400);
    });

    it('RF-BUS-003 por precio: algún servicio en el rango; "desde" es el más bajo que cumple', async () => {
      const res = await near('piura', { minPrice: 2000, maxPrice: 2500 }).expect(200);
      expect(names(res)).toEqual(['BARBERIA CENTRAL', 'Juan Barber']);
      expect((res.body.items as SearchItem[]).map((i) => i.priceFrom)).toEqual([
        { amount: 2000, currency: 'PEN' },
        { amount: 2500, currency: 'PEN' },
      ]);
      const ñandu = await near('piura', { q: 'nandu', category: 'haircut' }).expect(200);
      expect(ñandu.body.items[0].priceFrom).toEqual({ amount: 3000, currency: 'PEN' });
      const min = await near('piura', { minPrice: 3000, maxPrice: 1000 }).expect(400);
      expect(min.body.details).toEqual([{ field: 'maxPrice', constraints: ['gteMinPrice'] }]);
    });

    it('RF-BUS-003 por valoración mínima: excluye a las que no tienen valoraciones', async () => {
      expect(names(await near('piura', { minRating: 4.5 }).expect(200))).toEqual([
        'Barbería Ñandú',
        'Juan Barber',
      ]);
    });

    it('RF-BUS-003 por tipo: barbería o independiente', async () => {
      const independent = await near('piura', { type: 'INDEPENDENT' }).expect(200);
      expect(names(independent)).toEqual(['Juan Barber']);
      expect(independent.body.items[0].type).toBe('INDEPENDENT');
      const shops = await near('piura', { type: 'BARBERSHOP' }).expect(200);
      expect(names(shops)).not.toContain('Juan Barber');
      expect(names(shops)).toHaveLength(5);
      await near('piura', { type: 'OTRO' }).expect(400);
    });

    it('combina filtros (categoría + precio máximo + texto)', async () => {
      expect(
        names(
          await near('piura', { category: 'haircut', maxPrice: 2500, q: 'barber' }).expect(200),
        ),
      ).toEqual(['BARBERIA CENTRAL', 'Juan Barber']);
    });
  });

  describe('orden y ranking', () => {
    it('por valoración: las sin valoraciones van al final, con rating null y contador 0', async () => {
      const res = await near('piura', { sort: 'rating' }).expect(200);
      expect(names(res).slice(0, 4)).toEqual([
        'Barbería Ñandú',
        'Juan Barber',
        'BARBERIA CENTRAL',
        'Barbería Oculta',
      ]);
      const unrated = (res.body.items as SearchItem[]).slice(4);
      expect(unrated.map((i) => i.name).sort()).toEqual(['Estilo Norte', 'Salón Vacío']);
      for (const item of unrated) expect(item.rating).toEqual({ average: null, count: 0 });
      expect(res.body.items[0].rating).toEqual({ average: 4.8, count: 25 });
    });

    it('por precio: menor "desde" primero; sin servicios reservables al final', async () => {
      const res = await near('piura', { sort: 'price' }).expect(200);
      expect(names(res).slice(0, 4)).toEqual([
        'Barbería Ñandú',
        'BARBERIA CENTRAL',
        'Juan Barber',
        'Estilo Norte',
      ]);
      expect((res.body.items as SearchItem[]).slice(4).map((i) => i.priceFrom)).toEqual([
        null,
        null,
      ]);
    });

    it('ningún resultado está destacado todavía (Fase 13), pero el campo existe', async () => {
      const res = await near('piura').expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items as SearchItem[]) expect(item.featured).toBe(false);
    });

    it('ordenar por distancia exige ubicación', async () => {
      const res = await search({ sort: 'distance' }).expect(400);
      expect(res.body.details).toEqual([{ field: 'sort', constraints: ['requiresLocation'] }]);
    });
  });

  describe('paginación', () => {
    it('cursor: páginas sin repetidos que juntas dan el mismo resultado', async () => {
      for (const sort of ['distance', 'rating', 'price'] as const) {
        const full = names(await near('piura', { sort }).expect(200));
        const paged: string[] = [];
        let cursor: string | undefined;
        do {
          const res = await near('piura', { sort, limit: 2, cursor }).expect(200);
          expect(res.body.items.length).toBeLessThanOrEqual(2);
          paged.push(...names(res));
          cursor = res.body.nextCursor ?? undefined;
        } while (cursor);
        expect(paged).toEqual(full);
      }
    });

    it('el tamaño de página tiene tope (search.max_page_size)', async () => {
      await prisma.appSetting.create({ data: { key: 'search.max_page_size', value: 2 } });
      try {
        const res = await near('piura', { limit: 50 }).expect(200);
        expect(res.body.items).toHaveLength(2);
        expect(res.body.nextCursor).toEqual(expect.any(String));
      } finally {
        await prisma.appSetting.delete({ where: { key: 'search.max_page_size' } });
      }
      await near('piura', { limit: 101 }).expect(400);
      await near('piura', { limit: 0 }).expect(400);
    });

    it('un cursor alterado o de otro orden se rechaza (INVALID_CURSOR)', async () => {
      const page = await near('piura', { sort: 'rating', limit: 1 }).expect(200);
      const cursor = page.body.nextCursor as string;
      const otherSort = await near('piura', { sort: 'price', limit: 1, cursor }).expect(400);
      expect(otherSort.body.code).toBe('INVALID_CURSOR');
      const tampered = `${cursor.slice(0, -2)}${cursor.endsWith('AA') ? 'BB' : 'AA'}`;
      expect(
        (await near('piura', { sort: 'rating', cursor: tampered }).expect(400)).body.code,
      ).toBe('INVALID_CURSOR');
      await near('piura', { cursor: 'no/es+base64url' }).expect(400);
    });
  });

  describe('RF-BUS-003 disponibilidad (lunes 10:00 en Lima)', () => {
    it('sin filtros informa "abierta ahora" y "disponible ahora" de cada resultado', async () => {
      const res = await near('arequipa').expect(200);
      expect(
        (res.body.items as SearchItem[]).map((i) => [i.name, i.isOpenNow, i.availableNow]),
      ).toEqual([
        ['AQP 1', true, true],
        ['AQP 2', false, false],
        ['AQP 3', true, false],
        ['AQP 4', false, false],
      ]);
    });

    it('RF-BUS-003 "abierta ahora"', async () => {
      expect(names(await near('arequipa', { openNow: true }).expect(200))).toEqual([
        'AQP 1',
        'AQP 3',
      ]);
    });

    it('RF-BUS-003 "disponible ahora": abierta no basta, necesita un turno real', async () => {
      expect(names(await near('arequipa', { availableNow: true }).expect(200))).toEqual(['AQP 1']);
      expect(
        names(await near('arequipa', { availableNow: true, openNow: true }).expect(200)),
      ).toEqual(['AQP 1']);
    });

    it('RF-BUS-003 disponible en una fecha', async () => {
      expect(names(await near('arequipa', { date: MONDAY }).expect(200))).toEqual([
        'AQP 1',
        'AQP 2',
      ]);
      expect(names(await near('arequipa', { date: TUESDAY }).expect(200))).toEqual([]);
      expect(names(await near('arequipa', { date: '2030-01-06' }).expect(200))).toEqual([]);
      expect(names(await near('arequipa', { date: '2031-01-07' }).expect(200))).toEqual([]);
      const invalid = await near('arequipa', { date: '2030-02-30' }).expect(400);
      expect(invalid.body.details).toEqual([{ field: 'date', constraints: ['isDate'] }]);
    });

    it('"false" no filtra y un booleano mal escrito se rechaza', async () => {
      expect(names(await near('arequipa', { openNow: false }).expect(200))).toHaveLength(4);
      await near('arequipa', { openNow: 'si' }).expect(400);
    });

    it('tope de candidatos evaluados: devuelve lo encontrado con su cursor', async () => {
      await prisma.appSetting.create({ data: { key: 'search.max_candidates', value: 1 } });
      try {
        const pages: { names: string[]; limitReached: boolean; hasNext: boolean }[] = [];
        let cursor: string | undefined;
        do {
          const res = await near('arequipa', { openNow: true, cursor }).expect(200);
          pages.push({
            names: names(res),
            limitReached: res.body.evaluationLimitReached,
            hasNext: res.body.nextCursor !== null,
          });
          cursor = res.body.nextCursor ?? undefined;
        } while (cursor && pages.length < 10);
        expect(pages).toEqual([
          { names: ['AQP 1'], limitReached: true, hasNext: true },
          { names: [], limitReached: true, hasNext: true },
          { names: ['AQP 3'], limitReached: true, hasNext: true },
          { names: [], limitReached: true, hasNext: true },
          { names: [], limitReached: false, hasNext: false },
        ]);
      } finally {
        await prisma.appSetting.delete({ where: { key: 'search.max_candidates' } });
      }
    });
  });

  describe('RF-BUS-004 alternativas', () => {
    const alternatives = (shop: string, service: string, extra = '') =>
      api().get(
        `${SHOPS}/${ids[shop]}/alternatives?serviceId=${serviceIds[`${shop}/${service}`]}${extra}`,
      );

    it('RF-BUS-004 misma categoría, con turnos reales, cercanas primero; nunca la consultada', async () => {
      const res = await alternatives('TRU origen', 'Corte').expect(200);
      expect(res.body.date).toBe(MONDAY);
      expect(res.body.categoryKey).toBe('haircut');
      const items = res.body.items as {
        barbershop: SearchItem;
        service: { name: string; price: { amount: number } };
        firstSlot: { startAt: string; endAt: string };
      }[];
      expect(items.map((i) => i.barbershop.name)).toEqual(['TRU 1', 'TRU 6']);
      expect(items[0]!.firstSlot.startAt).toBe(new Date(lima(MONDAY, '10:00')).toISOString());
      expect(items[0]!.barbershop.distanceMeters).toBeGreaterThan(900);
      expect(items[0]!.barbershop.featured).toBe(false);
      // A igual turno, el servicio más barato de la categoría.
      expect(items[1]!.service).toMatchObject({ name: 'Corte simple', price: { amount: 2000 } });
    });

    it('RF-BUS-004 una fecha sin turnos en ninguna devuelve la lista vacía (nunca "disponible" falso)', async () => {
      const res = await alternatives('TRU origen', 'Corte', `&date=${TUESDAY}`).expect(200);
      expect(res.body.items).toEqual([]);
    });

    it('RF-BUS-004 servicio ajeno o barbería inexistente: 404', async () => {
      await api()
        .get(`${SHOPS}/${ids['TRU origen']}/alternatives?serviceId=${serviceIds['TRU 1/Corte']}`)
        .expect(404);
      await api()
        .get(
          `${SHOPS}/${ids['Cusco revisión']}/alternatives?serviceId=${serviceIds['TRU 1/Corte']}`,
        )
        .expect(404);
      await api().get(`${SHOPS}/${ids['TRU origen']}/alternatives`).expect(400);
    });
  });

  describe('validación de la ubicación', () => {
    it.each([
      ['lat sin lng', { lat: -12.05 }, 'lng', 'locationPair'],
      ['lng sin lat', { lng: -77.04 }, 'lat', 'locationPair'],
      ['radio sin ubicación', { radiusKm: 3 }, 'radiusKm', 'requiresLocation'],
    ])('rechaza %s', async (_case, params, field, constraint) => {
      const res = await search(params).expect(400);
      expect(res.body.details).toEqual([{ field, constraints: [constraint] }]);
    });

    it('rechaza coordenadas fuera de Perú', async () => {
      await search({ lat: 40.4, lng: -3.7 }).expect(400);
    });
  });

  describe('privacidad de la ubicación', () => {
    it('la ubicación no se guarda, no vuelve en la respuesta y el cursor no la revela', async () => {
      const lat = -12.046123;
      const lng = -77.041987;
      const before = await prisma.auditLog.count();
      const res = await search({ lat, lng, radiusKm: 25, limit: 1 }).expect(200);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('12.046123');
      expect(raw).not.toContain('77.041987');
      const cursor = res.body.nextCursor as string;
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      expect(decoded).not.toContain(String(res.body.items[0].distanceMeters));
      expect(decoded).not.toContain('distance');
      expect(await prisma.auditLog.count()).toBe(before);
    });
  });

  describe('límite de peticiones', () => {
    it('configurable (search.rate_limit_per_minute) y por IP', async () => {
      const refresher = app.get(SearchRateLimitRefresher);
      await prisma.appSetting.create({ data: { key: 'search.rate_limit_per_minute', value: 3 } });
      await refresher.refresh();
      try {
        const client = api();
        for (let i = 0; i < 3; i++) await client.get(`${SEARCH}?q=corte`).expect(200);
        const blocked = await client.get(`${SEARCH}?q=corte`).expect(429);
        expect(blocked.body.code).toBe('TOO_MANY_REQUESTS');
        // Las alternativas comparten el perfil; otra IP no está limitada.
        await api().get(`${SEARCH}?q=corte`).expect(200);
      } finally {
        await prisma.appSetting.delete({ where: { key: 'search.rate_limit_per_minute' } });
        await refresher.refresh();
      }
      expect(SEARCH_RATE_LIMIT.value).toBe(SEARCH_RATE_LIMIT_DEFAULT);
    });
  });
});
