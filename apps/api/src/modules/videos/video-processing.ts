import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import sharp from 'sharp';

const run = promisify(execFile);

/** Videos (Carrera del barbero): hasta 30 s y 50 MB; MP4, MOV o WebM. */
export const VIDEO_LIMITS = {
  maxBytes: 50 * 1024 * 1024,
  maxDurationMs: 30_500,
  /** Alto máximo de salida (720p). */
  maxHeight: 720,
} as const;

const ACCEPTED_FORMATS = ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm'];

export class VideoRejected extends Error {
  constructor(readonly reason: 'NOT_A_VIDEO' | 'TOO_LONG' | 'TOO_LARGE' | 'PROCESSING_FAILED') {
    super(reason);
  }
}

export interface ProcessedVideo {
  video: Buffer;
  poster: Buffer;
  durationMs: number;
  width: number;
  height: number;
}

/**
 * Valida y transcodifica un video en un directorio temporal (nunca dentro de una transacción):
 * - el formato y la duración se leen con ffprobe (el contenido, no la extensión);
 * - se convierte a H.264 + AAC, máximo 720p, `faststart` (empieza a reproducirse antes de bajar
 *   todo) y **sin metadatos** (`-map_metadata -1`: ni GPS ni modelo del teléfono);
 * - la miniatura (WebP) se toma del primer segundo.
 */
export async function processVideo(input: Buffer): Promise<ProcessedVideo> {
  if (input.length === 0) throw new VideoRejected('NOT_A_VIDEO');
  if (input.length > VIDEO_LIMITS.maxBytes) throw new VideoRejected('TOO_LARGE');
  if (!ffmpegPath) throw new VideoRejected('PROCESSING_FAILED');
  const dir = await mkdtemp(join(tmpdir(), 'charles-video-'));
  try {
    const source = join(dir, 'source');
    const output = join(dir, 'video.mp4');
    const posterFile = join(dir, 'poster.png');
    await writeFile(source, input);

    let probe: {
      format?: { format_name?: string; duration?: string };
      streams?: { codec_type?: string }[];
    };
    try {
      const { stdout } = await run(
        ffprobe.path,
        [
          '-v',
          'error',
          '-show_entries',
          'format=format_name,duration:stream=codec_type',
          '-of',
          'json',
          source,
        ],
        { timeout: 30_000 },
      );
      probe = JSON.parse(stdout) as typeof probe;
    } catch {
      throw new VideoRejected('NOT_A_VIDEO');
    }
    const formats = (probe.format?.format_name ?? '').split(',');
    const hasVideo = (probe.streams ?? []).some((s) => s.codec_type === 'video');
    if (!hasVideo || !formats.some((f) => ACCEPTED_FORMATS.includes(f))) {
      throw new VideoRejected('NOT_A_VIDEO');
    }
    const durationMs = Math.round(Number(probe.format?.duration ?? 0) * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw new VideoRejected('NOT_A_VIDEO');
    if (durationMs > VIDEO_LIMITS.maxDurationMs) throw new VideoRejected('TOO_LONG');

    try {
      await run(
        ffmpegPath,
        [
          '-y',
          '-i',
          source,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-map_metadata',
          '-1',
          '-vf',
          `scale=-2:'min(${VIDEO_LIMITS.maxHeight},ih)'`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '28',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          output,
        ],
        { timeout: 180_000 },
      );
      await run(
        ffmpegPath,
        ['-y', '-ss', durationMs > 1500 ? '1' : '0', '-i', output, '-frames:v', '1', posterFile],
        { timeout: 30_000 },
      );
    } catch {
      throw new VideoRejected('PROCESSING_FAILED');
    }
    const video = await readFile(output);
    const { data: poster, info } = await sharp(await readFile(posterFile))
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return { video, poster, durationMs, width: info.width, height: info.height };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
