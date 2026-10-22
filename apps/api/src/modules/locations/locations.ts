import { HttpStatus, Injectable, type OnModuleInit } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Ubicación de una barbería, un barbero o una oferta (lista fija UBIGEO del INEI). */
export class LocationDto {
  @ApiProperty({ example: '211101', description: 'Código UBIGEO del distrito (INEI).' })
  ubigeo!: string;

  @ApiProperty({ example: 'Juliaca' })
  district!: string;

  @ApiProperty({ example: 'San Roman' })
  province!: string;

  @ApiProperty({ example: 'Puno' })
  department!: string;
}

export interface District {
  id: string;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Registro en memoria de los distritos (datos de referencia fijos, ~1 900 filas): se carga al
 * arrancar y permite mostrar la ubicación sin consultas extra.
 */
const byId = new Map<string, District>();
const byUbigeo = new Map<string, District>();

export function locationOf(districtId: string | null | undefined): LocationDto | null {
  const d = districtId ? byId.get(districtId) : undefined;
  return d
    ? { ubigeo: d.ubigeo, district: d.district, province: d.province, department: d.department }
    : null;
}

export const PERU_UBIGEO = /^[0-9]{6}$/;

const invalidUbigeo = (field: string): AppException =>
  new AppException(
    ErrorCode.VALIDATION_ERROR,
    'Los datos enviados no son válidos.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: ['knownUbigeo'] }],
  );

const normalize = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

@Injectable()
export class LocationsService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const rows = await this.prisma.peruDistrict.findMany();
    byId.clear();
    byUbigeo.clear();
    for (const r of rows) {
      byId.set(r.id, r);
      byUbigeo.set(r.ubigeo, r);
    }
  }

  /** Distrito por UBIGEO; lanza 400 en `field` si no existe. */
  resolve(ubigeo: string, field = 'ubigeo'): District {
    const d = byUbigeo.get(ubigeo);
    if (!d) throw invalidUbigeo(field);
    return d;
  }

  byUbigeo(ubigeo: string): District | null {
    return byUbigeo.get(ubigeo) ?? null;
  }

  byId(id: string | null | undefined): District | null {
    return id ? (byId.get(id) ?? null) : null;
  }

  /** Distrito cuyo centro está más cerca del punto (para ubicar una barbería por su mapa). */
  nearest(latitude: number, longitude: number): District | null {
    let best: District | null = null;
    let bestD = Infinity;
    for (const d of byId.values()) {
      if (d.latitude === null || d.longitude === null) continue;
      const dLat = d.latitude - latitude;
      const dLng = (d.longitude - longitude) * Math.cos((latitude * Math.PI) / 180);
      const dist = dLat * dLat + dLng * dLng;
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    return best;
  }

  departments(): string[] {
    return [...new Set([...byId.values()].map((d) => d.department))].sort((a, b) =>
      a.localeCompare(b, 'es'),
    );
  }

  provinces(department?: string): { department: string; province: string }[] {
    const dep = department ? normalize(department) : null;
    const seen = new Map<string, { department: string; province: string }>();
    for (const d of byId.values()) {
      if (dep && normalize(d.department) !== dep) continue;
      seen.set(`${d.department}|${d.province}`, { department: d.department, province: d.province });
    }
    return [...seen.values()].sort(
      (a, b) =>
        a.department.localeCompare(b.department, 'es') ||
        a.province.localeCompare(b.province, 'es'),
    );
  }

  districts(filter: { department?: string; province?: string; q?: string }): District[] {
    const dep = filter.department ? normalize(filter.department) : null;
    const prov = filter.province ? normalize(filter.province) : null;
    const q = filter.q ? normalize(filter.q) : null;
    return [...byId.values()]
      .filter(
        (d) =>
          (!dep || normalize(d.department) === dep) &&
          (!prov || normalize(d.province) === prov) &&
          (!q || normalize(d.district).includes(q)),
      )
      .sort((a, b) => a.district.localeCompare(b.district, 'es'))
      .slice(0, 300);
  }

  /** IDs de los distritos de una provincia (para filtrar). */
  districtIdsOfProvince(province: string): string[] {
    const prov = normalize(province);
    return [...byId.values()].filter((d) => normalize(d.province) === prov).map((d) => d.id);
  }
}
