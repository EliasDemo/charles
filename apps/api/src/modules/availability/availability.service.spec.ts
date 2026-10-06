import { DateTime } from 'luxon';
import { AppException } from '../../common/errors/app.exception';
import type { BarbershopStatus } from '../../generated/prisma/enums';
import {
  type AvailabilityRequest,
  AvailabilityService,
  availabilityKey,
} from './availability.service';
import type { Interval } from './engine/intervals';
import type { WeeklyWindow } from './engine/local-time';

const LIMA = 'America/Lima';
const MONDAY = '2030-01-07';
const lima = (date: string, hhmm: string): number =>
  DateTime.fromISO(`${date}T${hhmm}`, { zone: LIMA }).toMillis();

interface World {
  now: number;
  shops: Record<string, { timezone: string; status: BarbershopStatus }>;
  hours: Record<string, WeeklyWindow[]>;
  /** serviceId → barbería y duración (solo servicios reservables). */
  services: Record<string, { barbershopId: string; durationMinutes: number }>;
  /** serviceId → barberos activos que lo realizan. */
  offering: Record<string, string[]>;
  schedules?: Record<string, WeeklyWindow[]>;
  blocks?: { barbershopId: string; barberId: string | null; startAt: Date; endAt: Date }[];
  busy?: Record<string, Interval[]>;
  settings?: Record<string, unknown>;
}

const mondayToFriday = (start: string, end: string): WeeklyWindow[] =>
  ([1, 2, 3, 4, 5] as const).map((dayOfWeek) => ({ dayOfWeek, start, end }));

function build(world: World) {
  const calls = { blocks: 0, busy: 0, contexts: 0 };
  const pick = <T>(map: Record<string, T>, ids: string[]) =>
    new Map(ids.filter((id) => id in map).map((id) => [id, map[id]!]));
  const service = new AvailabilityService(
    {
      businessHours: (ids: string[]) => Promise.resolve(pick(world.hours, ids)),
      barberSchedules: (ids: string[]) => Promise.resolve(pick(world.schedules ?? {}, ids)),
      blocks: (ids: string[], range: { from: Date; to: Date }) => {
        calls.blocks++;
        return Promise.resolve(
          (world.blocks ?? []).filter(
            (b) => ids.includes(b.barbershopId) && b.startAt < range.to && b.endAt > range.from,
          ),
        );
      },
    } as never,
    { publicScheduleInfo: (ids: string[]) => Promise.resolve(pick(world.shops, ids)) } as never,
    { bookableDurations: (ids: string[]) => Promise.resolve(pick(world.services, ids)) } as never,
    {
      activeBarbersByService: (ids: string[]) => Promise.resolve(pick(world.offering, ids)),
    } as never,
    {
      busyIntervals: (ids: string[]) => {
        calls.busy++;
        return Promise.resolve(pick(world.busy ?? {}, ids));
      },
    } as never,
    {
      get: (key: string) => Promise.resolve(world.settings?.[key] ?? null),
      positiveInt: (key: string, fallback: number) => {
        const v = world.settings?.[key];
        return Promise.resolve(typeof v === 'number' && v > 0 ? v : fallback);
      },
    } as never,
    { now: () => world.now },
  );
  return { service, calls };
}

/** Barbería abierta de lunes a viernes 09:00–13:00, servicio de 30 min con un barbero. */
const baseWorld = (): World => ({
  now: lima(MONDAY, '08:00'),
  shops: { shop: { timezone: LIMA, status: 'OPEN' } },
  hours: { shop: mondayToFriday('09:00', '13:00') },
  services: { svc: { barbershopId: 'shop', durationMinutes: 30 } },
  offering: { svc: ['barber'] },
});

const req = (overrides: Partial<AvailabilityRequest> = {}): AvailabilityRequest => ({
  barbershopId: 'shop',
  serviceId: 'svc',
  ...overrides,
});
const key = (r: AvailabilityRequest) => availabilityKey(r);
const hhmm = (ms: number | undefined) =>
  ms === undefined ? undefined : DateTime.fromMillis(ms, { zone: LIMA }).toFormat('HH:mm');

describe('AvailabilityService: cálculos por lotes (RF-DIS-002, RF-DIS-003, Fase 6)', () => {
  describe('loadContexts', () => {
    it('deja en null cada solicitud inválida y carga las válidas en pocas consultas', async () => {
      const world = baseWorld();
      world.shops.other = { timezone: LIMA, status: 'OPEN' };
      world.services.foreign = { barbershopId: 'other', durationMinutes: 30 };
      const { service, calls } = build(world);
      const requests = [
        req(),
        req({ barbershopId: 'hidden' }), // barbería no visible
        req({ serviceId: 'missing' }), // servicio no reservable
        req({ serviceId: 'foreign' }), // servicio de otra barbería
        req({ barberId: 'nobody' }), // barbero que no realiza el servicio
        req({ barberId: 'barber' }),
      ];
      const contexts = await service.loadContexts(requests, { from: 0, to: Date.now() });
      expect(requests.map((r) => contexts.get(key(r)) !== null)).toEqual([
        true,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(calls).toMatchObject({ blocks: 1, busy: 1 });
    });

    it('reparte bloqueos: de la barbería para todos y del barbero solo para él', async () => {
      const world = baseWorld();
      world.offering.svc = ['barber', 'other-barber'];
      const block = (barberId: string | null, from: string, to: string) => ({
        barbershopId: 'shop',
        barberId,
        startAt: new Date(lima(MONDAY, from)),
        endAt: new Date(lima(MONDAY, to)),
      });
      world.blocks = [block(null, '09:00', '10:00'), block('barber', '10:00', '11:00')];
      const { service } = build(world);
      const context = (
        await service.loadContexts([req()], { from: 0, to: lima(MONDAY, '23:00') })
      ).get(key(req()))!;
      expect(context.shopBlocks).toHaveLength(1);
      expect(context.barbers.map((b) => [b.id, b.blocks.length])).toEqual([
        ['barber', 1],
        ['other-barber', 0],
      ]);
    });
  });

  describe('availableOnDateBatch', () => {
    it('primer turno de la fecha en la zona de cada barbería', async () => {
      const { service } = build(baseWorld());
      const result = await service.availableOnDateBatch([req()], MONDAY);
      expect(hhmm(result.get(key(req()))?.start)).toBe('09:00');
    });

    it('fecha pasada o más allá del horizonte: null; solicitudes inválidas no aparecen', async () => {
      const world = baseWorld();
      world.settings = { 'availability.booking_horizon_days': 3 };
      const { service } = build(world);
      const requests = [req(), req({ serviceId: 'missing' })];
      for (const date of ['2030-01-06', '2030-01-11']) {
        const result = await service.availableOnDateBatch(requests, date);
        expect([...result.entries()]).toEqual([[key(req()), null]]);
      }
      expect((await service.availableOnDateBatch(requests, '2030-01-10')).get(key(req()))).not.toBe(
        null,
      );
    });

    it('sin turnos ese día (fin de semana): null', async () => {
      const { service } = build(baseWorld());
      expect((await service.availableOnDateBatch([req()], '2030-01-12')).get(key(req()))).toBe(
        null,
      );
    });

    it('cubre zonas al este y al oeste de UTC (la fecha local no es la de UTC)', async () => {
      const world = baseWorld();
      world.now = Date.parse('2030-01-06T12:00:00Z');
      world.shops = {
        tokyo: { timezone: 'Asia/Tokyo', status: 'OPEN' },
        honolulu: { timezone: 'Pacific/Honolulu', status: 'OPEN' },
      };
      world.hours = {
        tokyo: mondayToFriday('09:00', '10:00'),
        honolulu: mondayToFriday('20:00', '21:00'),
      };
      world.services = {
        a: { barbershopId: 'tokyo', durationMinutes: 30 },
        b: { barbershopId: 'honolulu', durationMinutes: 30 },
      };
      world.offering = { a: ['x'], b: ['y'] };
      const { service } = build(world);
      const requests = [
        { barbershopId: 'tokyo', serviceId: 'a' },
        { barbershopId: 'honolulu', serviceId: 'b' },
      ];
      const result = await service.availableOnDateBatch(requests, MONDAY);
      expect(result.get(key(requests[0]!))?.start).toBe(Date.parse('2030-01-07T00:00:00Z'));
      expect(result.get(key(requests[1]!))?.start).toBe(Date.parse('2030-01-08T06:00:00Z'));
    });
  });

  describe('openNowBatch', () => {
    it.each<[string, (w: World) => void, boolean]>([
      ['abierta y dentro del horario', () => undefined, true],
      ['antes de abrir', (w) => (w.now = lima(MONDAY, '08:59')), false],
      ['justo al cerrar (intervalo semiabierto)', (w) => (w.now = lima(MONDAY, '13:00')), false],
      ['cerrada temporalmente', (w) => (w.shops.shop!.status = 'TEMPORARILY_CLOSED'), false],
      ['no visible', (w) => (w.shops = {}), false],
      ['sin horario', (w) => (w.hours = {}), false],
      [
        'con un bloqueo de toda la barbería',
        (w) =>
          (w.blocks = [
            {
              barbershopId: 'shop',
              barberId: null,
              startAt: new Date(lima(MONDAY, '10:00')),
              endAt: new Date(lima(MONDAY, '11:00')),
            },
          ]),
        false,
      ],
      [
        'un bloqueo de un barbero no la cierra',
        (w) =>
          (w.blocks = [
            {
              barbershopId: 'shop',
              barberId: 'barber',
              startAt: new Date(lima(MONDAY, '10:00')),
              endAt: new Date(lima(MONDAY, '11:00')),
            },
          ]),
        true,
      ],
    ])('%s', async (_case, change, expected) => {
      const world = baseWorld();
      world.now = lima(MONDAY, '10:30');
      change(world);
      const { service } = build(world);
      expect((await service.openNowBatch(['shop'])).get('shop')).toBe(expected);
    });
  });

  describe('availableNowBatch', () => {
    it('turno dentro de la ventana "ahora"; fuera de ella, null', async () => {
      const world = baseWorld();
      world.now = lima(MONDAY, '08:40'); // ventana de 30 min: hasta 09:10
      const { service } = build(world);
      expect(hhmm((await service.availableNowBatch([req()])).get(key(req()))?.start)).toBe('09:00');
      world.now = lima(MONDAY, '08:00');
      expect((await service.availableNowBatch([req()])).get(key(req()))).toBe(null);
    });

    it('la ventana puede cruzar la medianoche local', async () => {
      const world = baseWorld();
      world.hours.shop = [
        { dayOfWeek: 1, start: '23:00', end: '23:55' },
        { dayOfWeek: 2, start: '00:00', end: '02:00' },
      ];
      world.now = lima(MONDAY, '23:50');
      const { service } = build(world);
      const slot = (await service.availableNowBatch([req()])).get(key(req()));
      expect(slot?.start).toBe(lima('2030-01-08', '00:00'));
    });

    it('una reserva activa ocupa el turno; las solicitudes inválidas no aparecen', async () => {
      const world = baseWorld();
      world.now = lima(MONDAY, '08:50');
      world.busy = {
        barber: [{ start: lima(MONDAY, '09:00'), end: lima(MONDAY, '09:30') }],
      };
      const { service } = build(world);
      const result = await service.availableNowBatch([req(), req({ serviceId: 'missing' })]);
      expect([...result.keys()]).toEqual([key(req())]);
      expect(result.get(key(req()))).toBe(null);
    });
  });

  describe('availableNow (una barbería)', () => {
    it('404 de servicio o de barbero según la solicitud', async () => {
      const { service } = build(baseWorld());
      const codeOf = async (r: AvailabilityRequest) => {
        try {
          await service.availableNow(r);
        } catch (error) {
          return error instanceof AppException ? error.userMessage : 'other';
        }
        return 'ok';
      };
      expect(await codeOf(req({ serviceId: 'missing' }))).toMatch(/servicio/);
      expect(await codeOf(req({ barberId: 'nobody' }))).toMatch(/barbero/);
      expect(await codeOf(req({ barbershopId: 'hidden' }))).toMatch(/barbería/);
      expect(await codeOf(req())).toBe('ok');
    });
  });

  describe('ajustes', () => {
    it('usa los valores por defecto si faltan o no son válidos (la anticipación admite 0)', async () => {
      const world = baseWorld();
      world.settings = { 'availability.min_lead_time_minutes': -5 };
      expect(await build(world).service.loadSettings()).toEqual({
        slotIntervalMinutes: 15,
        minLeadMinutes: 0,
        horizonDays: 30,
        nowWindowMinutes: 30,
      });
      world.settings = { 'availability.min_lead_time_minutes': 60 };
      expect((await build(world).service.loadSettings()).minLeadMinutes).toBe(60);
    });
  });
});
