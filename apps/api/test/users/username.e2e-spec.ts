import type { NestExpressApplication } from '@nestjs/platform-express';
import { AuthClient, createAuthTestApp, uniqueUsername } from '../support/auth';
import type { TestClock } from '../support/bookings';

const API = '/api/v1';
const ME = `${API}/users/me`;
const DAY = 86_400_000;

describe('Nombre de usuario: registro, inicio de sesión y cambio (e2e)', () => {
  let app: NestExpressApplication;
  const clock: TestClock = {
    current: Date.UTC(2030, 0, 7, 15),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
  });
  afterAll(() => app.close());

  it('el registro exige un usuario válido, libre y no reservado', async () => {
    const client = new AuthClient(app);
    const taken = uniqueUsername();
    await client.register({ username: taken }).expect(202);

    const dup = await client.register({ username: taken.toUpperCase() }).expect(409);
    expect(dup.body.code).toBe('USERNAME_TAKEN');

    const bad = await client.register({ username: 'a..b' }).expect(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
    const reserved = await client.register({ username: 'charles_oficial' }).expect(400);
    expect(reserved.body.details).toEqual([
      { field: 'username', constraints: ['usernameReserved'] },
    ]);
    await client.register({ username: undefined }).expect(400);
  });

  it('consulta de disponibilidad', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const check = (u: string) =>
      client.get(`${API}/auth/username-available?username=${encodeURIComponent(u)}`).expect(200);

    expect((await check(tokens.user.username)).body).toEqual({ available: false, reason: 'TAKEN' });
    expect((await check(uniqueUsername())).body).toEqual({ available: true, reason: null });
    expect((await check('admin')).body).toEqual({ available: false, reason: 'RESERVED' });
    expect((await check('.x')).body).toEqual({ available: false, reason: 'INVALID' });
  });

  it('inicia sesión con el usuario (sin distinguir mayúsculas) o con el correo', async () => {
    const client = new AuthClient(app);
    const { email, password, tokens } = await client.newUser();
    const username = tokens.user.username;

    const byUser = await client
      .post(`${API}/auth/login`, { login: username.toUpperCase(), password })
      .expect(200);
    expect(byUser.body.user).toMatchObject({ id: tokens.user.id, username });
    await client.post(`${API}/auth/login`, { login: email, password }).expect(200);
    // El campo `email` (obsoleto) sigue funcionando.
    await client.post(`${API}/auth/login`, { email, password }).expect(200);

    const wrong = await client
      .post(`${API}/auth/login`, { login: username, password: 'otra-clave-123' })
      .expect(401);
    const missing = await client
      .post(`${API}/auth/login`, { login: uniqueUsername(), password })
      .expect(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(missing.body.message).toBe(wrong.body.message);
    await client.post(`${API}/auth/login`, { password }).expect(400);
  });

  it('se cambia una vez cada 30 días y libera el anterior', async () => {
    const client = new AuthClient(app);
    const { tokens } = await client.newUser();
    const token = tokens.accessToken;
    const old = tokens.user.username;
    const first = uniqueUsername();

    const res = await client.patch(ME, { username: first }, token).expect(200);
    expect(res.body.username).toBe(first);
    expect(new Date(res.body.usernameChangeableAt).getTime()).toBe(clock.current + 30 * DAY);

    // Mismo usuario: no cuenta como cambio.
    await client.patch(ME, { username: first }, token).expect(200);

    const soon = await client.patch(ME, { username: uniqueUsername() }, token).expect(409);
    expect(soon.body.code).toBe('USERNAME_CHANGE_TOO_SOON');
    expect(soon.body.details[0].nextChangeAt).toBe(res.body.usernameChangeableAt);

    clock.current += 30 * DAY;
    const other = new AuthClient(app);
    const { tokens: otherTokens } = await other.newUser();
    const clash = await client
      .patch(ME, { username: otherTokens.user.username }, token)
      .expect(409);
    expect(clash.body.code).toBe('USERNAME_TAKEN');
    await client.patch(ME, { username: 'mal..nombre' }, token).expect(400);

    // El usuario anterior quedó libre.
    await new AuthClient(app).register({ username: old }).expect(202);
  });
});
