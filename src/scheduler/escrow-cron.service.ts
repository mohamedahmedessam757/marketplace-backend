import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { EscrowService } from '../payments/escrow.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class EscrowCronService {
    private readonly logger = new Logger(EscrowCronService.name);

    constructor(
        private prisma: PrismaService,
        private escrowService: EscrowService
    ) {}

    // Runs every hour to check for orders completed > 24 hours ago
    @Cron(CronExpression.EVERY_HOUR)
    async handleAutoRelease() {
        this.logger.log('Running Escrow Auto-Release Cron job (24h after COMPLETED)...');
        // ... (previous logic)
        const timeframe = new Date();
        timeframe.setHours(timeframe.getHours() - 24);

        try {
            const heldEscrows = await this.prisma.escrowTransaction.findMany({
                where: { status: 'HELD' }
            });

            for (const escrow of heldEscrows) {
                const order = await this.prisma.order.findUnique({
                    where: { id: escrow.orderId },
                    select: { status: true, updatedAt: true }
                });

                if (order?.status === 'COMPLETED' && order.updatedAt <= timeframe) {
                    this.logger.log(`Auto-releasing funds for completed order ${escrow.orderId}...`);
                    await this.escrowService.releaseFunds(escrow.orderId, 'AUTO_48H');
                }
            }
        } catch (error: any) {
            this.logger.error('Error during auto-release cron processing:', error.message);
        }
    }
}
