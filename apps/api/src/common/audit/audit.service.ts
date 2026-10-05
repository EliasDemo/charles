import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  /** Nulo = acción del sistema o de un usuario no autenticado. */
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Nunca datos sensibles: solo nombres de campos o estados. */
  changes?: Prisma.InputJsonValue;
  ip?: string | null;
}

type AuditClient = Pick<Prisma.TransactionClient, 'auditLog'>;

/** Registro de acciones sensibles en `audit_log` (solo inserción, CLAUDE.md §6.6). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** `tx` permite registrar dentro de la misma transacción que la acción auditada. */
  async record(entry: AuditEntry, tx: AuditClient = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        changes: entry.changes,
        ip: entry.ip ?? null,
      },
    });
  }
}
