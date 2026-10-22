import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { CLOCK, type Clock } from '../../common/clock/clock';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { REDIS_CLIENT } from '../../common/redis/redis.module';
import { SettingKey, SettingsService } from '../settings/settings.service';

export const COMMUNITY_DEFAULTS = {
  /** Reportes distintos que ocultan una publicación o comentario hasta que soporte la revise. */
  reportHideThreshold: 3,
  postsPerHour: 10,
  commentsPer10Min: 30,
  /** Me gusta, guardar, seguir, reportar…: acciones por minuto. */
  actionsPerMinute: 120,
} as const;

export const contentNotAllowed = (field: string): AppException =>
  new AppException(
    ErrorCode.CONTENT_NOT_ALLOWED,
    'El texto tiene palabras no permitidas en la comunidad. Revísalo y vuelve a intentarlo.',
    HttpStatus.BAD_REQUEST,
    [{ field, constraints: ['contentAllowed'] }],
  );

/** Normaliza para comparar sin tildes ni mayúsculas. */
export const normalizeText = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** ¿El texto contiene alguna palabra bloqueada (palabra completa)? */
export function hasBlockedWord(text: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const tokens = new Set(
    normalizeText(text)
      .split(/[^a-z0-9ñ]+/)
      .filter(Boolean),
  );
  return words.some((w) => {
    const word = normalizeText(w.trim());
    if (!word) return false;
    return word.includes(' ') ? normalizeText(text).includes(word) : tokens.has(word);
  });
}

/**
 * Reglas de la comunidad: filtro de palabras (`community.blocked_words`, separadas por comas) y
 * límites por cuenta en Redis (429 TOO_MANY_REQUESTS).
 */
@Injectable()
export class CommunityPolicy {
  private words: { at: number; list: string[] } = { at: 0, list: [] };

  constructor(
    private readonly settings: SettingsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async blockedWords(): Promise<string[]> {
    const now = this.clock.now();
    if (now - this.words.at < 60_000 && this.words.at !== 0) return this.words.list;
    const value = await this.settings.get(SettingKey.COMMUNITY_BLOCKED_WORDS);
    const list =
      typeof value === 'string'
        ? value
            .split(',')
            .map((w) => w.trim())
            .filter(Boolean)
        : [];
    this.words = { at: now, list };
    return list;
  }

  /** Lanza 400 CONTENT_NOT_ALLOWED si el texto tiene palabras bloqueadas. */
  async assertAllowed(text: string, field = 'body'): Promise<void> {
    if (hasBlockedWord(text, await this.blockedWords())) throw contentNotAllowed(field);
  }

  reportHideThreshold(): Promise<number> {
    return this.settings.positiveInt(
      SettingKey.COMMUNITY_REPORT_HIDE_THRESHOLD,
      COMMUNITY_DEFAULTS.reportHideThreshold,
    );
  }

  async limitPosts(userId: string): Promise<void> {
    const max = await this.settings.positiveInt(
      SettingKey.COMMUNITY_POSTS_PER_HOUR,
      COMMUNITY_DEFAULTS.postsPerHour,
    );
    await this.consume(`posts:${userId}`, 3600, max);
  }

  async limitComments(userId: string): Promise<void> {
    const max = await this.settings.positiveInt(
      SettingKey.COMMUNITY_COMMENTS_PER_10_MIN,
      COMMUNITY_DEFAULTS.commentsPer10Min,
    );
    await this.consume(`comments:${userId}`, 600, max);
  }

  limitActions(userId: string): Promise<void> {
    return this.consume(`actions:${userId}`, 60, COMMUNITY_DEFAULTS.actionsPerMinute);
  }

  private async consume(name: string, windowSeconds: number, max: number): Promise<void> {
    const window = Math.floor(this.clock.now() / (windowSeconds * 1000));
    const key = `rl:community:${name}:${window}`;
    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, windowSeconds * 2)
      .exec()) as [[Error | null, number], [Error | null, number]];
    if (count > max) {
      throw new AppException(
        ErrorCode.TOO_MANY_REQUESTS,
        'Vas muy rápido. Espera un momento e inténtalo de nuevo.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
