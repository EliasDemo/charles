import { Global, Module } from '@nestjs/common';

export const CLOCK = Symbol('CLOCK');

/** Reloj inyectable: las pruebas fijan "ahora" sin depender de la hora real. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
