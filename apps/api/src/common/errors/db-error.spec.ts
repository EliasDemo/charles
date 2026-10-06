import { Prisma } from '../../generated/prisma/client';
import { dbErrorInfo, isContention, isExclusionViolation } from './db-error';

const prismaError = (code: string, pgCode?: string) =>
  new Prisma.PrismaClientKnownRequestError('x', {
    code,
    clientVersion: 'test',
    meta: pgCode ? { driverAdapterError: { cause: { originalCode: pgCode } } } : undefined,
  });

describe('dbErrorInfo / clasificación de errores de la base', () => {
  it('toma el SQLSTATE anidado, no el código de Prisma (P2039 tiene el mismo formato)', () => {
    expect(dbErrorInfo(prismaError('P2039', '23P01'))).toEqual({
      prismaCode: 'P2039',
      pgCode: '23P01',
      constraint: null,
    });
    expect(dbErrorInfo(prismaError('P2002'))).toEqual({
      prismaCode: 'P2002',
      pgCode: null,
      constraint: null,
    });
  });

  it.each([
    ['bloqueo mutuo', prismaError('P2010', '40P01')],
    ['fallo de serialización', prismaError('P2010', '40001')],
    ['tiempo de espera de bloqueo', prismaError('P2010', '55P03')],
    ['conflicto de escritura de Prisma', prismaError('P2034')],
    ['transacción expirada de Prisma', prismaError('P2028')],
  ])('contención: %s', (_case, error) => {
    expect(isContention(dbErrorInfo(error))).toBe(true);
  });

  it('la violación de exclusión no es contención (sigue siendo 409)', () => {
    const info = dbErrorInfo(prismaError('P2039', '23P01'));
    expect(isExclusionViolation(info)).toBe(true);
    expect(isContention(info)).toBe(false);
  });

  it('errores que no son de la base: null', () => {
    expect(dbErrorInfo(new Error('x'))).toBeNull();
    expect(isContention(null)).toBe(false);
  });
});
