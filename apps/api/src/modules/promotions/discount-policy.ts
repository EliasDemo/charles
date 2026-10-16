/**
 * Descuentos de la Fase 13: qué promociones aplican a una reserva y cuál se usa. Pura, sin base de
 * datos ni reloj (recibe todo lo que necesita).
 *
 * Reglas (decididas con el usuario):
 * - **Un solo descuento por reserva:** el mayor entre las promociones aplicables (automáticas y la
 *   del cupón, si se envió uno). No se acumulan.
 * - **Siempre queda algo por pagar:** el descuento nunca deja el total por debajo de
 *   `MIN_PAYABLE_AMOUNT` (la pasarela no cobra S/ 0). Un servicio más barato que eso no se descuenta.
 * - **Quién lo asume:** la promoción de Charles (`PLATFORM`) la asume Charles; la de una barbería o
 *   un servicio, la barbería. La comisión se calcula sobre el precio ya descontado.
 */

export const MIN_PAYABLE_AMOUNT = 100; // S/ 1.00

export type PromotionScope = 'PLATFORM' | 'BARBERSHOP' | 'SERVICE';
export type PromotionType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type DiscountFunder = 'CHARLES' | 'BARBERSHOP';

/** Reglas opcionales guardadas en `promotions.rules`. */
export interface PromotionRules {
  /** Días de la semana de la cita en la zona de la barbería (0 = domingo). Vacío o ausente: todos. */
  daysOfWeek?: number[];
}

export interface PromotionCandidate {
  id: string;
  name: string;
  scope: PromotionScope;
  scopeId: string | null;
  type: PromotionType;
  /** PERCENTAGE: 1–100; FIXED_AMOUNT: céntimos en `currency`. */
  value: number;
  currency: string | null;
  rules: PromotionRules;
}

export interface BookingContext {
  barbershopId: string;
  serviceId: string;
  subtotal: number;
  currency: string;
  /** Día de la semana de la cita en la zona de la barbería (0 = domingo). */
  dayOfWeek: number;
}

export interface ChosenDiscount {
  promotion: PromotionCandidate;
  amount: number;
  funder: DiscountFunder;
}

/** ¿La promoción cubre esta reserva (alcance, moneda y reglas)? No mira vigencia ni topes. */
export function appliesTo(promotion: PromotionCandidate, ctx: BookingContext): boolean {
  if (promotion.scope === 'BARBERSHOP' && promotion.scopeId !== ctx.barbershopId) return false;
  if (promotion.scope === 'SERVICE' && promotion.scopeId !== ctx.serviceId) return false;
  if (promotion.type === 'FIXED_AMOUNT' && promotion.currency !== ctx.currency) return false;
  const days = promotion.rules.daysOfWeek;
  if (days && days.length > 0 && !days.includes(ctx.dayOfWeek)) return false;
  return true;
}

/** Descuento en céntimos que daría la promoción, ya con el mínimo a pagar respetado. */
export function discountAmount(promotion: PromotionCandidate, subtotal: number): number {
  const raw =
    promotion.type === 'PERCENTAGE'
      ? Math.round((subtotal * promotion.value) / 100)
      : promotion.value;
  const cap = Math.max(subtotal - MIN_PAYABLE_AMOUNT, 0);
  return Math.max(Math.min(raw, cap), 0);
}

export function funderOf(scope: PromotionScope): DiscountFunder {
  return scope === 'PLATFORM' ? 'CHARLES' : 'BARBERSHOP';
}

/**
 * El mayor descuento entre las candidatas que aplican. A igual monto gana la que asume Charles
 * (no le cuesta a la barbería) y luego la de id menor (resultado estable). `null` si ninguna da
 * un descuento mayor que cero.
 */
export function chooseBest(
  candidates: PromotionCandidate[],
  ctx: BookingContext,
): ChosenDiscount | null {
  let best: ChosenDiscount | null = null;
  for (const promotion of candidates) {
    if (!appliesTo(promotion, ctx)) continue;
    const amount = discountAmount(promotion, ctx.subtotal);
    if (amount <= 0) continue;
    const funder = funderOf(promotion.scope);
    if (
      !best ||
      amount > best.amount ||
      (amount === best.amount &&
        (rank(funder) < rank(best.funder) ||
          (funder === best.funder && promotion.id < best.promotion.id)))
    ) {
      best = { promotion, amount, funder };
    }
  }
  return best;
}

const rank = (funder: DiscountFunder): number => (funder === 'CHARLES' ? 0 : 1);

/** Lee `promotions.rules` sin confiar en su forma (es JSON). */
export function parseRules(value: unknown): PromotionRules {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const days = (value as { daysOfWeek?: unknown }).daysOfWeek;
  if (!Array.isArray(days)) return {};
  return {
    daysOfWeek: days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6),
  };
}
