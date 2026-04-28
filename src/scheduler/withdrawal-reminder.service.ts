import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class WithdrawalReminderService {
    private readonly logger = new Logger(WithdrawalReminderService.name);

    constructor(
        private prisma: PrismaService,
    ) {}

    // Run every 12 hours
    @Cron(CronExpression.EVERY_12_HOURS)
    async checkPendingWithdrawals() {
        this.logger.log('Starting check for overdue pending withdrawals...');
        
        try {
            // Find withdrawals pending for more than 48 hours
            const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

            const overdueRequests = await this.prisma.withdrawalRequest.findMany({
                where: {
                    status: 'PENDING',
                    createdAt: {
                        lte: fortyEightHoursAgo
                    }
                },
                include: {
                    store: { select: { name: true } },
                    user: { select: { name: true, email: true } }
                }
            });

            if (overdueRequests.length === 0) {
                return;
            }

            this.logger.log(`Found ${overdueRequests.length} overdue withdrawal requests.`);

            const admins = await this.prisma.user.findMany({
                where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] } }
            });

            for (const request of overdueRequests) {
                const entityName = request.role === 'CUSTOMER' ? (request.user?.name || request.user?.email) : (request.store?.name);
                
                for (const admin of admins) {
                    await this.prisma.notification.create({
                        data: {
                            recipientId: admin.id,
                            recipientRole: 'ADMIN',
                            type: 'SYSTEM',
                            titleAr: 'تذكير: طلب سحب متأخر ⏳',
                            titleEn: 'Reminder: Overdue Withdrawal Request ⏳',
                            messageAr: `طلب السحب الخاص بـ (${entityName}) بمبلغ ${request.amount} معلّق منذ أكثر من 48 ساعة. يرجى مراجعته.`,
                            messageEn: `The withdrawal request for (${entityName}) of ${request.amount} AED has been pending for over 48 hours. Please review it.`,
                            metadata: { type: 'WITHDRAWAL_REMINDER', requestId: request.id, role: request.role }
                        }
                    });
                }
            }

            this.logger.log('Overdue withdrawal reminders sent successfully.');
        } catch (error) {
            this.logger.error(`Error in checkPendingWithdrawals cron job: ${error.message}`);
        }
    }
}
