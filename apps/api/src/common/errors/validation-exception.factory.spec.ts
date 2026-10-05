import { ValidationError } from 'class-validator';
import { validationExceptionFactory } from './validation-exception.factory';

describe('validationExceptionFactory', () => {
  it('aplana errores anidados con ruta de campo y sin valores', () => {
    const child = Object.assign(new ValidationError(), {
      property: 'city',
      value: 'valor-privado',
      constraints: { isNotEmpty: 'city should not be empty' },
    });
    const parent = Object.assign(new ValidationError(), {
      property: 'address',
      children: [child],
    });
    const email = Object.assign(new ValidationError(), {
      property: 'email',
      value: 'persona@example.com',
      constraints: { isEmail: 'email must be an email' },
    });

    const exception = validationExceptionFactory([email, parent]);

    expect(exception.getStatus()).toBe(400);
    expect(exception.code).toBe('VALIDATION_ERROR');
    expect(exception.details).toEqual([
      { field: 'email', constraints: ['isEmail'] },
      { field: 'address.city', constraints: ['isNotEmpty'] },
    ]);
    expect(JSON.stringify(exception.details)).not.toMatch(/valor-privado|persona@/);
  });
});
