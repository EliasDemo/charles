import type { Request, Response } from 'express';
import type { AppConfig } from '../config/env.validation';
import { AppException } from '../errors/app.exception';
import { HttpsOnlyMiddleware } from './https-only.middleware';

function run(isProduction: boolean, secure: boolean): jest.Mock {
  const next = jest.fn();
  const middleware = new HttpsOnlyMiddleware({ isProduction } as AppConfig);
  middleware.use({ secure } as Request, {} as Response, next);
  return next;
}

describe('HttpsOnlyMiddleware', () => {
  it('en producción rechaza HTTP con HTTPS_REQUIRED', () => {
    expect(() => run(true, false)).toThrow(AppException);
    expect(() => run(true, false)).toThrow(expect.objectContaining({ code: 'HTTPS_REQUIRED' }));
  });

  it('en producción deja pasar HTTPS', () => {
    expect(run(true, true)).toHaveBeenCalled();
  });

  it('fuera de producción no exige HTTPS', () => {
    expect(run(false, false)).toHaveBeenCalled();
  });
});
