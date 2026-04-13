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
    
    // Ensure a reason exists for 2026 transparency standards
    let finalReason = data.reason;
    if (!finalReason) {
      if (data.actorType === 'SYSTEM') {
        finalReason = 'AUDIT_REASON_SYSTEM_AUTOMATED';
      } else {
        finalReason = 'AUDIT_REASON_NO_REASON_PROVIDED';
      }
    }

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
        reason: finalReason,
        metadata: data.metadata || {},
      },
    });
  }

  async findAll(cursor?: string, limit: number = 25) {
    const args: any = {
      orderBy: { timestamp: 'desc' },
      take: limit + 1, // Fetch one extra to check if there is more
    };

    if (cursor) {
      args.cursor = { id: cursor };
      args.skip = 1; // Skip the cursor element itself
    }

    const logs = await this.prisma.auditLog.findMany(args);
    
    let hasMore = false;
    if (logs.length > limit) {
      hasMore = true;
      logs.pop(); // Remove the extra record
    }

    return {
      data: logs,
      hasMore,
      nextCursor: hasMore ? logs[logs.length - 1].id : null,
    };
  }

  async findByOrder(orderId: string) {
    return this.prisma.auditLog.findMany({
      where: { orderId },
      orderBy: { timestamp: 'desc' },
    });
  }

  async findByAction(action: string) {
    return this.prisma.auditLog.findMany({
      where: { action },
      orderBy: { timestamp: 'desc' },
      take: 200, // Limit to recent 200 for monitoring
    });
  }
}
