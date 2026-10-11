import { getMetadataStorage } from 'class-validator';

/** Clave de metadatos de `@ApiProperty` en @nestjs/swagger (`DECORATORS.API_MODEL_PROPERTIES`). */
const API_MODEL_PROPERTIES = 'swagger/apiModelProperties';

interface ValidationMeta {
  propertyName: string;
  name?: string;
  constraints?: unknown[];
}

/**
 * Publica en el OpenAPI los límites de longitud de class-validator (`@Length`, `@MinLength`,
 * `@MaxLength`), que @nestjs/swagger no lee por sí solo. Así el contrato que usa la app refleja
 * exactamente lo que valida la API, sin repetir cada límite a mano.
 *
 * Solo completa propiedades ya documentadas con `@ApiProperty`; un `minLength`/`maxLength` escrito
 * a mano se respeta (si no coincide, la prueba `openapi-contract` lo detecta). Se llama antes de
 * generar el documento.
 */
export function publishValidationLimits(): void {
  const storage = getMetadataStorage() as unknown as {
    validationMetadatas: Map<object, ValidationMeta[]>;
  };
  for (const [target, metadatas] of storage.validationMetadatas) {
    for (const meta of metadatas) {
      const limits = lengthLimits(meta);
      if (!limits) continue;
      const prototype = (target as { prototype?: object }).prototype;
      if (!prototype) continue;
      const current = Reflect.getMetadata(API_MODEL_PROPERTIES, prototype, meta.propertyName) as
        Record<string, unknown> | undefined;
      if (!current) continue; // propiedad no documentada: no se inventa en el contrato
      const next = { ...current };
      if (limits.min !== undefined && next.minLength === undefined) next.minLength = limits.min;
      if (limits.max !== undefined && next.maxLength === undefined) next.maxLength = limits.max;
      Reflect.defineMetadata(API_MODEL_PROPERTIES, next, prototype, meta.propertyName);
    }
  }
}

function lengthLimits(meta: ValidationMeta): { min?: number; max?: number } | null {
  const [a, b] = (meta.constraints ?? []) as (number | undefined)[];
  switch (meta.name) {
    case 'isLength':
      return { min: a, max: b };
    case 'minLength':
      return { min: a };
    case 'maxLength':
      return { max: a };
    default:
      return null;
  }
}
