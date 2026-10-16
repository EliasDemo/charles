import { planApplicationUpdate, planJobApplication, planNewMessage } from './notification-catalog';

describe('Avisos de la Carrera del barbero', () => {
  it('mensaje nuevo: sin el contenido; correo solo con el primer no leído', () => {
    const [first] = planNewMessage({
      recipientIds: ['u-1'],
      conversationId: 'c-1',
      from: 'Barbería Centro',
      withEmail: true,
    });
    expect(first).toMatchObject({
      userId: 'u-1',
      type: 'NEW_MESSAGE',
      channels: ['PUSH', 'IN_APP', 'EMAIL'],
      urgent: true,
      resource: { type: 'conversation', id: 'c-1' },
    });
    expect(first!.email!.subject).toBe('Tienes un mensaje nuevo de Barbería Centro');
    const [next] = planNewMessage({
      recipientIds: ['u-1'],
      conversationId: 'c-1',
      from: 'Barbería Centro',
      withEmail: false,
    });
    expect(next!.channels).toEqual(['PUSH', 'IN_APP']);
  });

  it('postulación recibida: a cada responsable de la barbería', () => {
    const plans = planJobApplication({
      staffIds: ['o-1', 'm-1'],
      applicationId: 'a-1',
      barberName: 'Luis',
      postingTitle: 'Barbero',
    });
    expect(plans.map((p) => p.userId)).toEqual(['o-1', 'm-1']);
    expect(plans[0]).toMatchObject({
      type: 'JOB_APPLICATION_RECEIVED',
      resource: { type: 'job_application', id: 'a-1' },
    });
    expect(plans[0]!.detail.body).toBe('Luis postuló a «Barbero».');
  });

  it('postulación actualizada: preseleccionado, rechazado o contratado; nada en otros estados', () => {
    const input = {
      userId: 'b-1',
      applicationId: 'a-1',
      barbershopName: 'Centro',
      postingTitle: 'X',
    };
    expect(planApplicationUpdate({ ...input, status: 'HIRED' })[0]!.detail.body).toContain(
      'te contrató',
    );
    expect(planApplicationUpdate({ ...input, status: 'SHORTLISTED' })[0]!.detail.body).toContain(
      'preseleccionó',
    );
    expect(planApplicationUpdate({ ...input, status: 'REJECTED' })).toHaveLength(1);
    expect(planApplicationUpdate({ ...input, status: 'WITHDRAWN' })).toEqual([]);
  });
});
