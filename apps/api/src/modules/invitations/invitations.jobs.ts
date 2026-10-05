import type { BarbershopMemberRole } from '../../generated/prisma/enums';

export const INVITATIONS_QUEUE = 'barbershop-invitations';

/**
 * Trabajos de invitación. Sin datos personales en claro: el invitado va como índice ciego (hex).
 * El worker resuelve la cuenta; si no existe o no aplica, no hace nada (la API respondió igual).
 */
export type InvitationJob =
  | {
      type: 'member';
      barbershopId: string;
      role: BarbershopMemberRole;
      emailHashHex: string;
      invitedById: string;
    }
  | {
      type: 'barber';
      barbershopId: string;
      barberId: string;
      emailHashHex: string;
      invitedById: string;
    };
