import { type Algorithm, hash, verify } from '@node-rs/argon2';

// `Algorithm` es un const enum (incompatible con isolatedModules): Argon2id = 2.
const ARGON2ID = 2 as Algorithm.Argon2id;

/**
 * Parámetros Argon2id (recomendación OWASP: m=19 MiB, t=2, p=1).
 * Cambiarlos no invalida hashes existentes: los parámetros van dentro del hash.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash de contraseñas con Argon2id (CLAUDE.md §6.2). Nunca registrar la contraseña. */
export const PasswordHasher = {
  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  },

  /** Devuelve `false` (sin lanzar) ante un hash mal formado. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  },
};
