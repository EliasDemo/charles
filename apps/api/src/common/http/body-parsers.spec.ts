import { bodyParserErrorToAppException } from './body-parsers';

describe('bodyParserErrorToAppException', () => {
  it('JSON mal formado → MALFORMED_JSON', () => {
    const error = bodyParserErrorToAppException({ type: 'entity.parse.failed', status: 400 });
    expect(error.code).toBe('MALFORMED_JSON');
    expect(error.getStatus()).toBe(400);
  });

  it('cuerpo demasiado grande → PAYLOAD_TOO_LARGE', () => {
    const error = bodyParserErrorToAppException({ type: 'entity.too.large', status: 413 });
    expect(error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(error.getStatus()).toBe(413);
  });

  it('codificación no soportada → UNSUPPORTED_MEDIA_TYPE', () => {
    const error = bodyParserErrorToAppException({ type: 'encoding.unsupported', status: 415 });
    expect(error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('errores sin estado 4xx → BAD_REQUEST', () => {
    expect(bodyParserErrorToAppException(new Error('x')).code).toBe('BAD_REQUEST');
    expect(bodyParserErrorToAppException({ status: 500 }).getStatus()).toBe(400);
  });
});
