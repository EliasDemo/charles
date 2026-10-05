import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MAILER, type Mailer } from '../../common/mail/mailer';
import { BarbersService } from '../barbers/barbers.service';
import { BarbershopAccessService } from '../barbershops/barbershop-access.service';
import { UsersService } from '../users/users.service';
import { INVITATIONS_QUEUE, type InvitationJob } from './invitations.jobs';
import { InvitationsService } from './invitations.service';

const ROLE_LABEL = { OWNER: 'responsable (OWNER)', MANAGER: 'administrador (MANAGER)' } as const;
const SIGNATURE = '\n\n— El equipo de Charles';

/**
 * Resuelve la cuenta invitada, comprueba que la invitación aplique, la crea y envía el código.
 * Si no aplica (cuenta inexistente, ya es responsable, el barbero ya tiene cuenta...), no hace nada.
 */
@Processor(INVITATIONS_QUEUE)
export class InvitationsProcessor extends WorkerHost {
  constructor(
    private readonly invitations: InvitationsService,
    private readonly users: UsersService,
    private readonly barbers: BarbersService,
    private readonly barbershops: BarbershopAccessService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {
    super();
  }

  async process(job: Job<InvitationJob>): Promise<void> {
    const data = job.data;
    const invitee = await this.users.findCredentialsByEmailHash(
      Buffer.from(Buffer.from(data.emailHashHex, 'hex')),
    );
    if (!invitee || invitee.isDeleted || invitee.status !== 'ACTIVE') return;

    const shopName = (await this.barbershops.names([data.barbershopId])).get(data.barbershopId);
    if (!shopName) return;

    if (data.type === 'member') {
      if (await this.barbershops.isMember(data.barbershopId, invitee.id)) return;
    } else if (!(await this.barbers.canLink(data.barbershopId, data.barberId, invitee.id))) {
      return;
    }

    const to = await this.users.contactEmail(invitee.id);
    if (!to) return;
    const { code } = await this.invitations.issue(data, invitee.id);
    const what =
      data.type === 'member'
        ? `ser ${ROLE_LABEL[data.role]} de la barbería "${shopName}"`
        : `vincular tu cuenta como barbero de "${shopName}"`;
    await this.mailer.send({
      to,
      category: data.type === 'member' ? 'member-invitation' : 'barber-invitation',
      subject: `Invitación de Charles: ${shopName}`,
      text:
        `Te invitaron a ${what}.\n\nPara aceptar, entra a Charles con tu cuenta y usa este código: ${code}\n` +
        'El código es de un solo uso y vence pronto.\n\nSi no esperabas esta invitación, ignora este mensaje.' +
        SIGNATURE,
    });
  }
}
