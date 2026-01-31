import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ActorType, Prisma } from '@prisma/client';

export interface CreateAuditLogDto {
  orderId?: string;
  action: string;
  entity: string;
  actorType: ActorType;
  actorId?: string;
  actorName?: string;
  previousState?: string;
  newState?: string;
  reason?: string;
  metadata?: any;
}

@Injectable()
export class AuditLogsService {
  constructor(private prisma: PrismaService) { }

  async logAction(data: CreateAuditLogDto, tx?: Prisma.TransactionClient) {
    const prisma = tx || this.prisma;
    return prisma.auditLog.create({
      data: {
        orderId: data.orderId,
        action: data.action,
        entity: data.entity,
        actorType: data.actorType,
        actorId: data.actorId,
        actorName: data.actorName,
        previousState: data.previousState,
        newState: data.newState,
        reason: data.reason,
        metadata: data.metadata || {},
      },
    });
  }

  async findAll() {
    return this.prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 100, // Limit for M1
    });
  }

  async findByOrder(orderId: string) {
    return this.prisma.auditLog.findMany({
      where: { orderId },
      orderBy: { timestamp: 'desc' },
    });
  }
}
