import type { PrismaClient } from '../../src/generated/prisma/client';
import type {
  FaceShape,
  HairType,
  MaintenanceLevel,
  StyleVibe,
} from '../../src/generated/prisma/enums';

/**
 * Datos de referencia de la recomendación por forma de cara (Etapa 1).
 *
 * Los puntajes vienen de criterios generales de barbería (dar altura a una cara redonda, no alargar
 * más una cara alargada, equilibrar una frente ancha...) y se cargan como **no validados**: un
 * ADMIN los ajusta en la web con la opinión de barberos y, más adelante, con evidencia real
 * (reservas y valoraciones). Idempotente: completa lo que falte y nunca pisa lo editado.
 */

interface StyleInfo {
  description: string;
  maintenance: MaintenanceLevel;
  hairTypes: HairType[];
  vibe: StyleVibe;
}

const ALL_HAIR: HairType[] = ['STRAIGHT', 'WAVY', 'CURLY', 'COILY'];

export const HAIRCUT_INFO: Record<string, StyleInfo> = {
  fade_low: {
    description: 'Degradado que empieza cerca de la oreja: limpio y discreto.',
    maintenance: 'MEDIUM',
    hairTypes: ALL_HAIR,
    vibe: 'CLASSIC',
  },
  fade_mid: {
    description: 'Degradado a media altura: equilibrio entre limpio y marcado.',
    maintenance: 'MEDIUM',
    hairTypes: ALL_HAIR,
    vibe: 'MODERN',
  },
  fade_high: {
    description: 'Degradado alto que deja los lados muy cortos y destaca la parte de arriba.',
    maintenance: 'HIGH',
    hairTypes: ALL_HAIR,
    vibe: 'MODERN',
  },
  taper: {
    description: 'Disminución suave solo en patillas y nuca; muy versátil.',
    maintenance: 'LOW',
    hairTypes: ALL_HAIR,
    vibe: 'CLASSIC',
  },
  buzz_cut: {
    description: 'Todo corto con máquina; casi no requiere peinado.',
    maintenance: 'LOW',
    hairTypes: ALL_HAIR,
    vibe: 'CLASSIC',
  },
  crop: {
    description: 'Arriba texturizado con flequillo corto hacia adelante.',
    maintenance: 'LOW',
    hairTypes: ['STRAIGHT', 'WAVY', 'CURLY'],
    vibe: 'MODERN',
  },
  pompadour: {
    description: 'Volumen alto hacia atrás con lados cortos; requiere producto.',
    maintenance: 'HIGH',
    hairTypes: ['STRAIGHT', 'WAVY'],
    vibe: 'CLASSIC',
  },
  classic_scissors: {
    description: 'Corte tradicional a tijera, natural y fácil de llevar.',
    maintenance: 'LOW',
    hairTypes: ['STRAIGHT', 'WAVY', 'CURLY'],
    vibe: 'CLASSIC',
  },
  mullet: {
    description: 'Corto adelante y a los lados, largo atrás.',
    maintenance: 'MEDIUM',
    hairTypes: ['STRAIGHT', 'WAVY', 'CURLY'],
    vibe: 'MODERN',
  },
  hair_design: {
    description: 'Líneas o figuras marcadas con máquina sobre un degradado.',
    maintenance: 'HIGH',
    hairTypes: ALL_HAIR,
    vibe: 'MODERN',
  },
  quiff: {
    description: 'Volumen al frente peinado hacia arriba y atrás, lados cortos.',
    maintenance: 'HIGH',
    hairTypes: ['STRAIGHT', 'WAVY'],
    vibe: 'MODERN',
  },
  undercut: {
    description: 'Lados y nuca muy cortos sin degradar; arriba largo.',
    maintenance: 'MEDIUM',
    hairTypes: ['STRAIGHT', 'WAVY'],
    vibe: 'MODERN',
  },
  side_part: {
    description: 'Raya marcada a un costado, ordenado y formal.',
    maintenance: 'MEDIUM',
    hairTypes: ['STRAIGHT', 'WAVY'],
    vibe: 'CLASSIC',
  },
  slick_back: {
    description: 'Peinado hacia atrás con producto; arriba medio largo.',
    maintenance: 'MEDIUM',
    hairTypes: ['STRAIGHT', 'WAVY'],
    vibe: 'CLASSIC',
  },
  curly_top: {
    description: 'Rizos definidos arriba con lados degradados.',
    maintenance: 'MEDIUM',
    hairTypes: ['WAVY', 'CURLY', 'COILY'],
    vibe: 'MODERN',
  },
};

const SHAPES: FaceShape[] = ['OVAL', 'ROUND', 'SQUARE', 'OBLONG', 'HEART', 'DIAMOND'];

/** Puntaje (0–100) por corte, en el orden de SHAPES. */
const SCORES: Record<string, [number, number, number, number, number, number]> = {
  //              OVAL ROUND SQUARE OBLONG HEART DIAMOND
  fade_low: [85, 60, 80, 75, 75, 70],
  fade_mid: [85, 75, 80, 65, 65, 65],
  fade_high: [80, 85, 70, 45, 55, 55],
  taper: [85, 65, 80, 75, 80, 75],
  buzz_cut: [80, 40, 85, 65, 60, 50],
  crop: [85, 55, 85, 90, 85, 85],
  pompadour: [85, 90, 75, 35, 55, 65],
  classic_scissors: [85, 60, 80, 80, 80, 80],
  mullet: [65, 50, 60, 65, 70, 70],
  hair_design: [70, 60, 65, 60, 60, 60],
  quiff: [85, 90, 80, 40, 65, 75],
  undercut: [80, 80, 75, 55, 55, 60],
  side_part: [85, 75, 85, 80, 80, 80],
  slick_back: [80, 70, 80, 50, 60, 65],
  curly_top: [80, 75, 75, 70, 75, 75],
};

/** Por qué se recomienda (o no) cada forma con ciertos cortes: notas visibles para el cliente. */
const NOTES: Partial<Record<FaceShape, { high: string; low: string }>> = {
  OVAL: {
    high: 'La cara ovalada admite casi cualquier corte.',
    low: 'Funciona, aunque no es lo que más la favorece.',
  },
  ROUND: {
    high: 'Da altura arriba y deja los lados cortos: alarga visualmente la cara redonda.',
    low: 'Puede ensanchar la cara redonda.',
  },
  SQUARE: {
    high: 'Acompaña una mandíbula marcada sin endurecer los rasgos.',
    low: 'Puede hacer ver la cara más angulosa.',
  },
  OBLONG: {
    high: 'Suma volumen a los lados o flequillo y no alarga más la cara.',
    low: 'La altura arriba alarga todavía más una cara alargada.',
  },
  HEART: {
    high: 'Equilibra una frente ancha con una mandíbula más fina.',
    low: 'Puede acentuar el ancho de la frente.',
  },
  DIAMOND: {
    high: 'Suaviza los pómulos anchos y da cuerpo a frente y mentón.',
    low: 'Los lados muy cortos acentúan los pómulos.',
  },
};

export async function seedFaceShapeReference(
  prisma: PrismaClient,
): Promise<{ styles: number; rules: number }> {
  let styles = 0;
  let rules = 0;
  for (const [key, info] of Object.entries(HAIRCUT_INFO)) {
    const style = await prisma.serviceStyle.findUnique({ where: { key } });
    if (!style) continue;
    // Solo completa lo que esté vacío (no pisa lo que un ADMIN editó).
    if (!style.description || !style.maintenance || !style.vibe || style.hairTypes.length === 0) {
      await prisma.serviceStyle.update({
        where: { id: style.id },
        data: {
          description: style.description ?? info.description,
          maintenance: style.maintenance ?? info.maintenance,
          vibe: style.vibe ?? info.vibe,
          hairTypes: style.hairTypes.length > 0 ? style.hairTypes : info.hairTypes,
        },
      });
      styles++;
    }
    const scores = SCORES[key];
    if (!scores) continue;
    for (const [i, faceShape] of SHAPES.entries()) {
      const score = scores[i]!;
      const exists = await prisma.faceShapeRule.findUnique({
        where: { faceShape_styleId: { faceShape, styleId: style.id } },
      });
      if (exists) continue;
      const note = NOTES[faceShape];
      await prisma.faceShapeRule.create({
        data: {
          faceShape,
          styleId: style.id,
          score,
          note: score >= 80 ? note?.high : score <= 55 ? note?.low : null,
          validated: false,
        },
      });
      rules++;
    }
  }
  return { styles, rules };
}
