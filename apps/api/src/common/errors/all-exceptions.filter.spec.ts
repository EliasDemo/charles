import {
  type ArgumentsHost,
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '../../generated/prisma/client';
import { AllExceptionsFilter, toErrorResponse } from './all-exceptions.filter';
import { AppException } from './app.exception';

describe('toErrorResponse', () => {
  it('usa código, mensaje y detalles de AppException', () => {
    const error = new AppException('SLOT_NOT_AVAILABLE', 'El horario ya no está disponible.', 409, [
      { slot: 'x' },
    ]);
    expect(toErrorResponse(error, 'req-1')).toEqual({
      status: 409,
      body: {
        code: 'SLOT_NOT_AVAILABLE',
        message: 'El horario ya no está disponible.',
        details: [{ slot: 'x' }],
        requestId: 'req-1',
      },
    });
  });

  it('no expone el mensaje original de una HttpException de Nest', () => {
    const { status, body } = toErrorResponse(new NotFoundException('Cannot GET /x'), 'r');
    expect(status).toBe(404);
    expect(body).toEqual({
      code: 'NOT_FOUND',
      message: 'El recurso solicitado no existe.',
      details: [],
      requestId: 'r',
    });
  });

  it('traduce el 429 del límite de peticiones', () => {
    expect(toErrorResponse(new ThrottlerException(), 'r').body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('usa BAD_REQUEST genérico para estados 4xx sin mensaje propio', () => {
    expect(toErrorResponse(new BadRequestException('detalle'), 'r').body).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'La solicitud no es válida.',
    });
    expect(toErrorResponse(new AppException('X', 'y', HttpStatus.GONE), 'r').status).toBe(410);
  });

  it('convierte errores desconocidos en 500 sin filtrar detalles', () => {
    const { status, body } = toErrorResponse(new Error('contraseña=1234'), 'r');
    expect(status).toBe(500);
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('1234');
  });
});

describe('AllExceptionsFilter', () => {
  function hostFor(headersSent = false) {
    const res = { headersSent, status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = {
      switchToHttp: () => ({ getRequest: () => ({ id: 'req-9' }), getResponse: () => res }),
    } as unknown as ArgumentsHost;
    return { host, res };
  }

  it('responde con el requestId de la petición', () => {
    const { host, res } = hostFor();
    new AllExceptionsFilter().catch(new NotFoundException(), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-9' }));
  });

  it('no escribe si la respuesta ya fue enviada', () => {
    const { host, res } = hostFor(true);
    new AllExceptionsFilter().catch(new NotFoundException(), host);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('AllExceptionsFilter: registro de errores de base de datos (sin datos personales)', () => {
  function host(): ArgumentsHost {
    const res = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() };
    const req = { id: 'req-9', method: 'POST', route: { path: '/api/v1/bookings' } };
    return {
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ArgumentsHost;
  }

  it('un 500 de Prisma se registra con los códigos de Prisma y PostgreSQL, sin el mensaje', () => {
    const filter = new AllExceptionsFilter();
    const logger = jest
      .spyOn((filter as unknown as { logger: { error: jest.Mock } }).logger, 'error')
      .mockImplementation(() => undefined);
    const error = new Prisma.PrismaClientKnownRequestError(
      'Invalid `tx.booking.create()` invocation: email ana@example.com',
      {
        code: 'P2003',
        clientVersion: 'test',
        meta: { driverAdapterError: { cause: { originalCode: '23503', constraint: 'fk_x' } } },
      },
    );
    filter.catch(error, host());
    const [entry] = logger.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({
      db: { prismaCode: 'P2003', pgCode: '23503', constraint: 'fk_x' },
      code: 'INTERNAL_ERROR',
      requestId: 'req-9',
      route: 'POST /api/v1/bookings',
    });
    expect(JSON.stringify(entry)).not.toContain('ana@example.com');
  });
});
