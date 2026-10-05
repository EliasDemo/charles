import {
  type ArgumentsHost,
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
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
