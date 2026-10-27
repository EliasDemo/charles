import { MailDeliveryError, ResendMailer } from './resend-mailer';

const message = {
  to: 'ana@example.com',
  subject: 'Hola',
  text: 'Texto',
  category: 'password-reset',
};
const mailer = (
  resendApiKey: string | null = 're_x',
  from: string | null = 'Charles <no@charles.pe>',
) => new ResendMailer({ mail: { driver: 'resend', resendApiKey, from } } as never);

describe('ResendMailer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('envía a la API de Resend con la clave, el remitente y la categoría', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as never;
    await mailer().send(message);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_x');
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: 'Charles <no@charles.pe>',
      to: ['ana@example.com'],
      subject: 'Hola',
      tags: [{ name: 'category', value: 'password-reset' }],
    });
  });

  it('sin configurar, rechazado o sin respuesta: MailDeliveryError (se reintenta)', async () => {
    await expect(mailer(null).send(message)).rejects.toBeInstanceOf(MailDeliveryError);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 422 }) as never;
    await expect(mailer().send(message)).rejects.toMatchObject({ status: 422 });
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as never;
    await expect(mailer().send(message)).rejects.toMatchObject({ status: null });
  });
});
