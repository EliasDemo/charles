import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ffmpegPath from 'ffmpeg-static';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { VideosService } from '../../src/modules/videos/videos.service';
import { AuthClient, createAuthTestApp } from '../support/auth';
import { API, bookingKit, type BookingKit, lima, MONDAY } from '../support/bookings';

/** Video de prueba generado con ffmpeg (barras de color), con metadatos de "teléfono". */
function testVideo(seconds: number): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'charles-test-video-'));
  try {
    const file = join(dir, 'in.mp4');
    execFileSync(
      ffmpegPath!,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc=size=640x360:rate=15:duration=${seconds}`,
        '-metadata',
        'location=+12.0464-077.0428/',
        '-metadata',
        'title=TelefonoX',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        file,
      ],
      { stdio: 'ignore' },
    );
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Carrera del barbero: videos de 30 s. */
describe('Videos (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let kit: BookingKit;
  const clock = {
    current: lima(MONDAY, '08:00'),
    now() {
      return this.current;
    },
  };

  beforeAll(async () => {
    app = await createAuthTestApp({ clock });
    prisma = app.get(PrismaService);
    kit = bookingKit(app, clock);
  });
  afterAll(() => app.close());

  function upload(who: { client: AuthClient; token: string }, path: string, file: Buffer) {
    return who.client.http
      .post(path)
      .set('X-Forwarded-For', who.client.ip)
      .set('Authorization', `Bearer ${who.token}`)
      .field('caption', 'Nuestro local')
      .attach('file', file, { filename: 'video.mp4', contentType: 'video/mp4' });
  }

  it('la barbería sube un video: se procesa a MP4 sin metadatos y se ve en público', async () => {
    const shop = await kit.shopReady();
    const res = await upload(
      shop.owner,
      `${API}/barbershops/${shop.shopId}/videos`,
      testVideo(3),
    ).expect(202);
    expect(res.body).toMatchObject({ status: 'PROCESSING', videoUrl: null });
    await app.get(VideosService).process(res.body.id as string);

    const list = await new AuthClient(app)
      .get(`${API}/barbershops/${shop.shopId}/videos`)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: res.body.id,
        status: 'READY',
        videoUrl: expect.stringMatching(/\/api\/v1\/media\/vid\/[A-Za-z0-9_-]{22}\/video\.mp4$/),
        posterUrl: expect.stringMatching(/poster\.webp$/),
        caption: 'Nuestro local',
      }),
    ]);
    expect(list.body[0].durationMs).toBeGreaterThan(2500);
    const file = await new AuthClient(app).get(list.body[0].videoUrl as string).expect(200);
    expect(file.headers['content-type']).toBe('video/mp4');
    expect(Buffer.from(file.body as Buffer).toString('latin1')).not.toContain('TelefonoX');
  });

  it('más de 30 s o algo que no es video: FAILED con el motivo (solo para quien lo subió)', async () => {
    const shop = await kit.shopReady();
    const long = await upload(
      shop.owner,
      `${API}/barbershops/${shop.shopId}/videos`,
      testVideo(32),
    ).expect(202);
    const junk = await upload(
      shop.owner,
      `${API}/barbershops/${shop.shopId}/videos`,
      Buffer.from('no es video'),
    ).expect(202);
    await app.get(VideosService).process(long.body.id as string);
    await app.get(VideosService).process(junk.body.id as string);
    const manage = await shop.owner.client
      .get(`${API}/barbershops/${shop.shopId}/videos/manage`, shop.owner.token)
      .expect(200);
    const byId = Object.fromEntries(manage.body.map((v: { id: string }) => [v.id, v]));
    expect(byId[long.body.id]).toMatchObject({ status: 'FAILED', failureReason: 'TOO_LONG' });
    expect(byId[junk.body.id]).toMatchObject({ status: 'FAILED', failureReason: 'NOT_A_VIDEO' });
    expect(
      (await new AuthClient(app).get(`${API}/barbershops/${shop.shopId}/videos`).expect(200)).body,
    ).toEqual([]);
  });

  it('el barbero sube videos a su perfil; tope, borrado y reportes', async () => {
    const barber = await kit.verified();
    await upload(barber, `${API}/me/barber-profile/videos`, testVideo(1)).expect(404);
    const profile = await barber.client
      .put(`${API}/me/barber-profile`, { displayName: 'Video Barber' }, barber.token)
      .expect(200);
    const video = await upload(barber, `${API}/me/barber-profile/videos`, testVideo(2)).expect(202);
    await app.get(VideosService).process(video.body.id as string);
    const pub = await new AuthClient(app)
      .get(`${API}/barber-profiles/${profile.body.id}/videos`)
      .expect(200);
    expect(pub.body).toHaveLength(1);

    const viewer = await kit.verified();
    await barber.client
      .post(`${API}/videos/${video.body.id}/report`, { reason: 'OTHER' }, barber.token)
      .expect(403);
    await viewer.client
      .post(`${API}/videos/${video.body.id}/report`, { reason: 'INAPPROPRIATE' }, viewer.token)
      .expect(204);
    expect(await prisma.videoReport.count({ where: { videoId: video.body.id } })).toBe(1);

    await viewer.client.delete(`${API}/videos/${video.body.id}`, viewer.token).expect(404);
    await barber.client.delete(`${API}/videos/${video.body.id}`, barber.token).expect(204);
    expect(
      (
        await new AuthClient(app)
          .get(`${API}/barber-profiles/${profile.body.id}/videos`)
          .expect(200)
      ).body,
    ).toEqual([]);
  });
});
