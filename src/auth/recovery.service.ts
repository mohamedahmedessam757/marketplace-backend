import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { ActorType } from '@prisma/client';
import { OtpService } from './otp.service';
import { OtpPurpose } from './otp-purpose';

@Injectable()
export class RecoveryService {
    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService,
        private auditLogs: AuditLogsService,
        private platformSettings: PlatformSettingsService,
        private otpService: OtpService,
    ) { }

    async requestEmailOtp(email: string, role: 'customer' | 'merchant') {
        const userRole = role === 'merchant' ? 'VENDOR' : 'CUSTOMER';

        const user = await this.prisma.user.findFirst({ where: { email, role: userRole } });
        if (!user) {
            throw new BadRequestException('Email not found in our records');
        }

        if (!user.phone) {
            throw new BadRequestException('No phone on file for this account');
        }

        await this.otpService.issueAndSend({
            channel: 'email',
            email: user.email,
            phone: user.phone ?? undefined,
            purpose: OtpPurpose.RECOVERY_STEP1,
            audience: role === 'merchant' ? 'vendor' : 'customer',
            name: user.name ?? undefined,
            role,
        });

        // Log action
        await this.prisma.securityLog.create({
            data: {
                email,
                userId: user.id,
                action: 'RECOVERY_EMAIL_OTP_SENT',
                isSuccess: true,
            },
        });

        // 2026 Global Audit
        await this.auditLogs.logAction({
            action: 'RECOVERY_REQUEST',
            entity: 'USER',
            actorType: user.role as any,
            actorId: user.id,
            actorName: user.name,
            reason: 'OTP Request for Email Recovery',
            metadata: { email, role }
        });

        return {
            success: true,
            message: 'Verification code sent to your email address on file.',
            channel: 'email',
        };
    }

    async verifyEmailOtp(email: string, otp: string, role: 'customer' | 'merchant', ip?: string) {
        const userRole = role === 'merchant' ? 'VENDOR' : 'CUSTOMER';
        const user = await this.prisma.user.findFirst({ where: { email, role: userRole } });
        if (!user?.phone) {
            throw new BadRequestException('User not found');
        }

        try {
            await this.otpService.verify({
                channel: 'email',
                email: user.email,
                purpose: OtpPurpose.RECOVERY_STEP1,
                code: otp,
            });
        } catch (err) {
            await this.logSecurityEvent(email, `RECOVERY_EMAIL_OTP_FAILED_${role.toUpperCase()}`, false, ip);
            throw err;
        }

        await this.logSecurityEvent(email, `RECOVERY_EMAIL_OTP_VERIFIED_${role.toUpperCase()}`, true, ip);
        return { success: true };
    }

    async requestPhoneOtp(email: string, newPhone: string, role: 'customer' | 'merchant', ip?: string) {
        await this.otpService.assertRecoveryStep1Verified(email, role);

        const userRole = role === 'merchant' ? 'VENDOR' : 'CUSTOMER';
        const user = await this.prisma.user.findFirst({ where: { email, role: userRole } });

        await this.otpService.issueAndSend({
            channel: 'whatsapp',
            phone: newPhone,
            email,
            purpose: OtpPurpose.RECOVERY_PHONE,
            audience: role === 'merchant' ? 'vendor' : 'customer',
            name: user?.name ?? undefined,
            role,
            metadata: { newPhone },
        });

        await this.logSecurityEvent(email, `RECOVERY_PHONE_OTP_SENT_${role.toUpperCase()}`, true, ip);
        return { success: true, message: 'OTP sent to new phone number via WhatsApp', channel: 'whatsapp' };
    }

    async submitRecovery(email: string, newPhone: string, phoneOtp: string, role: 'customer' | 'merchant', ip?: string, device?: string) {
        await this.otpService.assertRecoveryStep1Verified(email, role);

        try {
            await this.otpService.verify({
                channel: 'whatsapp',
                phone: newPhone,
                email,
                purpose: OtpPurpose.RECOVERY_PHONE,
                code: phoneOtp,
            });
        } catch (err) {
            throw err;
        }

        const userRole = role === 'merchant' ? 'VENDOR' : 'CUSTOMER';
        // OTP Verified. Now Run Risk Engine.
        const user = await this.prisma.user.findFirst({
            where: { email, role: userRole },
            include: { store: true },
        });

        if (!user) throw new BadRequestException('User not found');

        // Fetch aggregates in real-time
        const [ordersCount, disputesCount, returnsCount] = await Promise.all([
            this.prisma.order.count({
                where: { customerId: user.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } }
            }),
            this.prisma.dispute.count({
                where: { order: { customerId: user.id }, status: { notIn: ['RESOLVED', 'CLOSED'] } }
            }),
            this.prisma.returnRequest.count({
                where: { order: { customerId: user.id }, status: { notIn: ['REJECTED'] } }
            })
        ]);

        // Check aggregates in real-time
        let balance = Number(user.customerBalance) || 0;
        let vendorOrdersCount = 0;
        let merchantDisputesCount = 0;

        if (user.store) {
            balance += Number(user.store.balance) || 0;
            const [vOrders, mDisputes] = await Promise.all([
                this.prisma.order.count({
                    where: { storeId: user.store.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } }
                }),
                this.prisma.dispute.count({
                    where: { order: { storeId: user.store.id }, status: { notIn: ['RESOLVED'] } }
                })
            ]);
            vendorOrdersCount = vOrders;
            merchantDisputesCount = mDisputes;
        }

        const totalActiveOrders = ordersCount + vendorOrdersCount;
        const totalDisputes = disputesCount + returnsCount + merchantDisputesCount;

        const isHighRisk = balance > 0 || totalActiveOrders > 0 || totalDisputes > 0;

        if (isHighRisk) {
            // Create Pending Review Request
            await this.prisma.accountRecoveryRequest.create({
                data: {
                    userId: user.id,
                    oldPhone: user.phone,
                    newPhone: newPhone,
                    status: 'PENDING_REVIEW',
                    balanceSnapshot: balance,
                    openOrdersCount: totalActiveOrders,
                    disputesCount: totalDisputes,
                    requestIp: ip,
                    requestDevice: device,
                }
            });

            await this.prisma.user.update({
                where: { id: user.id },
                data: { recoveryStatus: 'PENDING_REVIEW' }
            });

            // --- NOTIFICATION: ALERT ADMINS ---
            await this.notifications.notifyAdmins({
                titleAr: 'طلب استرداد حساب جديد',
                titleEn: 'New Account Recovery Request',
                messageAr: `المستخدم ${user.name} قدم طلب استرداد برقم جديد يحتاج مراجعة.`,
                messageEn: `User ${user.name} submitted a recovery request that requires review.`,
                type: 'alert',
                link: '/admin/account-recovery'
            });

            await this.logSecurityEvent(email, `RECOVERY_QUEUED_FOR_ADMIN_${role.toUpperCase()}`, true, ip, device);

            // 2026 Global Audit
            await this.auditLogs.logAction({
                action: 'RECOVERY_SUBMITTED',
                entity: 'AccountRecoveryRequest',
                actorType: user.role as any,
                actorId: user.id,
                actorName: user.name,
                reason: 'Recovery request queued for admin review (High Risk)',
                metadata: { email, newPhone, balance, totalActiveOrders }
            });

            return {
                success: true,
                action: 'PENDING_REVIEW',
                message: 'For your security, this request requires admin review due to active balances or orders.'
            };

        } else {
            // Safe to auto-update
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    phone: newPhone,
                    withdrawalsFrozenUntil: new Date(Date.now() + 12 * 60 * 60 * 1000) // Freeze for 12 hours
                }
            });

            // Persistent Notification for the user
            await this.notifications.create({
                recipientId: user.id,
                recipientRole: role === 'merchant' ? 'VENDOR' : 'CUSTOMER',
                titleAr: 'تم تحديث رقم الجوال بنجاح ✅',
                titleEn: 'Phone Number Updated Successfully ✅',
                messageAr: 'تم تحديث رقم جوالك المرتبط بالحساب. لأمانك، تم تجميد عمليات السحب لمدة 12 ساعة.',
                messageEn: 'Your account phone number has been updated. For security, withdrawals are frozen for 12 hours.',
                type: 'alert',
                link: '/dashboard/profile'
            });

            // 2026 Global Audit
            await this.auditLogs.logAction({
                action: 'RECOVERY_AUTO_APPROVED',
                entity: 'USER',
                actorType: user.role as any,
                actorId: user.id,
                actorName: user.name,
                reason: 'Account recovery auto-approved (Low Risk)',
                metadata: { email, newPhone }
            });

            await this.logSecurityEvent(email, `RECOVERY_AUTO_APPROVED_${role.toUpperCase()}`, true, ip, device);

            return {
                success: true,
                action: 'APPROVED',
                message: 'Phone number updated successfully.'
            };
        }
    }

    // --- ADMIN APIs ---

    async getPendingRequests() {
        const requests = await this.prisma.accountRecoveryRequest.findMany({
            orderBy: { createdAt: 'desc' },
            include: {
                user: {
                    include: {
                        store: { select: { balance: true, id: true } }
                    }
                }
            }
        });

        // Enrich requests with LIVE data to ensure 100% accuracy in the admin dashboard
        return Promise.all(requests.map(async (req) => {
            const user = req.user;
            const userId = req.userId;
            const storeId = user.store?.id;
            const isMerchant = user.role === 'VENDOR';

            // Fetch TOTAL activity (all orders ever made/received by this user)
            const [ordersAsCustomer, ordersAsMerchant, disputesAsCustomer, returnsAsCustomer, disputesAsMerchant] = await Promise.all([
                this.prisma.order.count({ where: { customerId: userId } }),
                storeId ? this.prisma.order.count({ where: { storeId } }) : 0,
                this.prisma.dispute.count({ where: { order: { customerId: userId }, status: { notIn: ['RESOLVED'] } } }),
                this.prisma.returnRequest.count({ where: { order: { customerId: userId }, status: { notIn: ['REJECTED'] } } }),
                storeId ? this.prisma.dispute.count({ where: { order: { storeId }, status: { notIn: ['RESOLVED'] } } }) : 0
            ]);

            const liveOrders = ordersAsCustomer + ordersAsMerchant;
            const liveDisputes = disputesAsCustomer + returnsAsCustomer + disputesAsMerchant;

            // Calculate live balance based on role
            let liveBalance = isMerchant && user.store ? Number(user.store.balance) : Number((user as any).customerBalance);

            return {
                ...req,
                balanceSnapshot: liveBalance || 0,
                openOrdersCount: liveOrders,
                disputesCount: liveDisputes,
                userRole: user.role // Explicitly pass the role for frontend navigation
            };
        }));
    }

    async resolveRequest(requestId: string, action: 'APPROVE' | 'REJECT', adminId?: string, ip?: string, userAgent?: string) {
        const request = await this.prisma.accountRecoveryRequest.findUnique({
            where: { id: requestId },
            include: { user: true }
        });

        if (!request || request.status !== 'PENDING_REVIEW') {
            throw new BadRequestException('Request not found or already resolved');
        }

        if (action === 'APPROVE') {
            // Update phone
            await this.prisma.user.update({
                where: { id: request.userId },
                data: {
                    phone: request.newPhone,
                    recoveryStatus: 'APPROVED',
                    withdrawalsFrozenUntil: new Date(Date.now() + 12 * 60 * 60 * 1000) // Freeze withdrawals for 12h after manual approval
                }
            });

            // --- NOTIFICATION: NOTIFY USER OF APPROVAL ---
            await this.notifications.notifyUser(request.userId, request.user.role, {
                titleAr: 'تمت الموافقة على استرداد الحساب',
                titleEn: 'Account Recovery Approved',
                messageAr: 'تم تحديث رقم هاتفك. لأمانك، تم تجميد السحب لمدة 12 ساعة.',
                messageEn: 'Your phone number was updated. For security, withdrawals are frozen for 12 hours.',
                type: 'system'
            });

            // --- NOTIFICATION: SECURITY ALERT (NEW DEVICE/IDENTITY) ---
            await this.notifications.notifyUser(request.userId, request.user.role, {
                titleAr: 'تنبيه أمني: تحديث هوية الحساب',
                titleEn: 'Security Alert: Account Identity Updated',
                messageAr: 'تم التعرف على رقم هاتف جديد كجهاز موثوق. إذا لم تكن أنت من قام بهذا التغيير، يرجى التواصل معنا فوراً.',
                messageEn: 'A new phone number has been recognized as a trusted device. If you did not authorize this, contact support immediately.',
                type: 'alert'
            });

            await this.logSecurityEvent(request.user.email, 'RECOVERY_MANUALLY_APPROVED', true);
        } else {
            await this.prisma.user.update({
                where: { id: request.userId },
                data: { recoveryStatus: null }
            });

            // --- NOTIFICATION: NOTIFY USER OF REJECTION ---
            await this.notifications.notifyUser(request.userId, request.user.role, {
                titleAr: 'تم رفض طلب استرداد الحساب',
                titleEn: 'Account Recovery Rejected',
                messageAr: 'نأسف، تم رفض طلب تحديث هاتفك. يرجى التواصل مع الدعم.',
                messageEn: 'Sorry, your recovery request was rejected. Please contact support.',
                type: 'alert'
            });

            await this.logSecurityEvent(request.user.email, 'RECOVERY_MANUALLY_REJECTED', true);
        }

        // --- NEW: RECORD ADMIN ACTIVITY LOG ---
        const logData = {
            adminId: adminId || null,
            action: `ACCOUNT_RECOVERY_${action}`,
            ipAddress: ip,
            userAgent: userAgent,
            email: request.user.email,
            metadata: {
                requestId,
                targetUserId: request.userId,
                snapshot: {
                    balance: request.balanceSnapshot,
                    orders: request.openOrdersCount,
                    disputes: request.disputesCount
                }
            }
        };

        // 2026 Admin Session Management: Deduplicated Activity Logging
        await this.platformSettings.logAdminActivity(
            adminId || 'SYSTEM',
            request.user.email,
            `ACCOUNT_RECOVERY_${action}`,
            logData.metadata,
            { ip, ua: userAgent }
        );

        // 2026 Global Audit
        await this.auditLogs.logAction({
            action: action === 'APPROVE' ? 'RECOVERY_APPROVED' : 'RECOVERY_REJECTED',
            entity: 'AccountRecoveryRequest',
            actorType: 'ADMIN',
            actorId: adminId,
            reason: `Admin ${action.toLowerCase()}d account recovery for ${request.user.email}`,
            metadata: { requestId, targetUserId: request.userId, action }
        });

        // Update request status
        return this.prisma.accountRecoveryRequest.update({
            where: { id: requestId },
            data: {
                status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
                resolvedAt: new Date(),
                resolvedBy: adminId || null
            }
        });
    }

    private async logSecurityEvent(email: string, action: string, isSuccess: boolean, ip?: string, device?: string) {
        const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
        await this.prisma.securityLog.create({
            data: {
                email,
                userId: user?.id,
                action,
                isSuccess,
                ipAddress: ip,
                device: device,
            }
        });
    }
}
