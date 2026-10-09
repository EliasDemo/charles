import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contrato del OpenAPI que consume la app (tipos generados en packages/shared). `pnpm verify`
 * comprueba antes que `openapi.json` esté al día con el código; esta prueba revisa su forma.
 *
 * Defecto que evita: una propiedad declarada sin tipo (por ejemplo `string | null` con solo
 * `nullable: true`) sale como `object` vacío y el tipo generado para la app queda mal.
 */
type Schema = Record<string, unknown> & {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: unknown;
};

const spec = JSON.parse(readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8')) as {
  components: { schemas: Record<string, Schema> };
};

function problems(schema: Schema, path: string): string[] {
  const found: string[] = [];
  const typed =
    schema.type !== undefined ||
    schema.$ref !== undefined ||
    schema.oneOf !== undefined ||
    schema.anyOf !== undefined ||
    schema.allOf !== undefined ||
    schema.enum !== undefined;
  if (!typed) found.push(`${path}: sin tipo`);
  if (
    schema.type === 'object' &&
    schema.properties === undefined &&
    schema.additionalProperties === undefined &&
    // `allOf: [{ $ref }]` es como Swagger expresa una referencia anulable: está tipada.
    schema.allOf === undefined &&
    schema.oneOf === undefined
  ) {
    found.push(`${path}: object sin estructura (¿falta type en @ApiProperty?)`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    found.push(...problems(child, `${path}.${name}`));
  }
  if (schema.type === 'array' && schema.items && Object.keys(schema.items).length > 0) {
    found.push(...problems(schema.items, `${path}[]`));
  }
  return found;
}

describe('Contrato OpenAPI', () => {
  it('toda propiedad tiene un tipo concreto (ningún object vacío por un tipo no declarado)', () => {
    const found = Object.entries(spec.components.schemas).flatMap(([name, schema]) =>
      problems(schema, name),
    );
    expect(found).toEqual([]);
  });

  it('el número de documento del responsable publica su pattern (8 u 11 dígitos)', () => {
    const number = spec.components.schemas.OwnerDocumentInputDto?.properties?.number;
    expect(number).toMatchObject({
      type: 'string',
      pattern: String.raw`^\d{8}(\d{3})?$`,
      minLength: 8,
      maxLength: 11,
    });
    expect(String(number?.description)).toMatch(/prefijo 10, 15, 17 o 20/);
  });

  it('la comprobación detecta el defecto (control)', () => {
    expect(problems({ type: 'object', nullable: true }, 'X.phone')).toEqual([
      'X.phone: object sin estructura (¿falta type en @ApiProperty?)',
    ]);
    expect(problems({ nullable: true }, 'X.y')).toEqual(['X.y: sin tipo']);
  });
});
