import { randomBytes } from 'node:crypto';
import { PasswordHasher } from './password-hasher';

describe('PasswordHasher (Argon2id)', () => {
  const password = randomBytes(12).toString('base64');

  it('genera un hash Argon2id con los parámetros configurados y lo verifica', async () => {
    const hash = await PasswordHasher.hash(password);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain(password);
    await expect(PasswordHasher.verify(hash, password)).resolves.toBe(true);
  });

  it('rechaza una contraseña incorrecta', async () => {
    const hash = await PasswordHasher.hash(password);
    await expect(PasswordHasher.verify(hash, `${password}x`)).resolves.toBe(false);
  });

  it('usa sal aleatoria: dos hashes de la misma contraseña difieren', async () => {
    expect(await PasswordHasher.hash(password)).not.toBe(await PasswordHasher.hash(password));
  });

  it('devuelve false ante un hash mal formado', async () => {
    await expect(PasswordHasher.verify('no-es-un-hash', password)).resolves.toBe(false);
  });
});
