import type { Job } from 'bullmq';
import { NotificationsProcessor } from './notifications.job';
import type { NotificationsService } from './notifications.service';

describe('RF-NOT Fase 10: trabajos programados', () => {
  it('cada trabajo llama a su tarea; la entrega vacía la cola por lotes', async () => {
    const calls: string[] = [];
    let batches = 2;
    const service = {
      deliverDue: () => {
        calls.push('deliver');
        return Promise.resolve(batches-- > 0 ? 50 : 0);
      },
      scanReminders: () => (calls.push('reminders'), Promise.resolve(0)),
      checkReceipts: () => (calls.push('receipts'), Promise.resolve(0)),
      purgeOld: () => (calls.push('purge'), Promise.resolve(0)),
    } as unknown as NotificationsService;
    const processor = new NotificationsProcessor(service);
    for (const name of ['deliver', 'reminders', 'receipts', 'purge', 'otro']) {
      await processor.process({ name } as Job);
    }
    expect(calls).toEqual(['deliver', 'deliver', 'deliver', 'reminders', 'receipts', 'purge']);
  });
});
