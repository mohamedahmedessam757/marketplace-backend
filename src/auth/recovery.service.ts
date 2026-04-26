import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class RecoveryService {
    constructor(
        private prisma: PrismaService,
        private notifications: NotificationsService
    ) { }

    // In a real app, this would use Redis for rate limiting and OTP storage.
    // For this MVP, we will use a local Map or a clean DB structure if needed,
    // but since we are following the requirements of just returning 123456 for now,
    // we will simulate the cache.

    private otpCache = new Map<string, { otp: string, expires: number, attempts: number, role: string }>();

    async requestEmailOtp(email: string, role: 'customer' | 'merchant') {
        const userRole = role === 'merchant' ? 'VENDOR' : 'CUSTOMER';

        const user = await this.prisma.user.findFirst({ where: { email, role: userRole } });
        if (!user) {
            throw new BadRequestException('Email not found in our records');
        }

        // Generate OTP and store in cache with 10 min expiration
        const otp = '123456'; // Dev OTP as requested
        this.otpCache.set(`${role}_${email}`, {
            otp,
            expires: Date.now() + 10 * 60 * 1000,
            attempts: 0,
            role
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

        return { success: true, message: 'An OTP has been sent to your email.' };
    }

    async verifyEmailOtp(email: string, otp: string, role: 'customer' | 'merchant', ip?: string) {
        const cached = this.otpCache.get(`${role}_${email}`);

        if (!cached || cached.expires < Date.now()) {
            await this.logSecurityEvent(email, `RECOVERY_EMAIL_OTP_EXPIRED_${role.toUpperCase()}`, false, ip);
            throw new BadRequestException('OTP expired or not requested');
        }

        if (cached.attempts >= 5) {
            await this.logSecurityEvent(email, 'RECOVERY_BLOCKED_BRUTE_FORCE', false, ip);
            throw new UnauthorizedException('Too many failed attempts. Please try again later.');
        }

        if (cached.otp !== otp) {
            cached.attempts += 1;
            await this.logSecurityEvent(email, `RECOVERY_EMAIL_OTP_FAILED_${role.toUpperCase()}`, false, ip);
            throw new BadRequestException(`Invalid OTP. Attempts remaining: ${5 - cached.attempts}`);
        }

        // Success
        this.otpCache.delete(`${role}_${email}`); // Clear OTP after success
        await this.logSecurityEvent(email, `RECOVERY_EMAIL_OTP_VERIFIED_${role.toUpperCase()}`, true, ip);

        // Set a session flag in cache to allow step 2
        this.otpCache.set(`${role}_${email}_verified`, { otp: 'true', expires: Date.now() + 15 * 60 * 1000, attempts: 0, role });

        return { success: true };
    }

    async requestPhoneOtp(email: string, newPhone: string, role: 'customer' | 'merchant', ip?: string) {
        const isVerified = this.otpCache.get(`${role}_${email}_verified`);
        if (!isVerified || isVerified.expires < Date.now()) {
            throw new UnauthorizedException('Session expired. Please restart the recovery process.');
        }

        // Generate phone OTP
        const phoneOtp = '123456'; // Dev OTP
        this.otpCache.set(`${role}_${email}_phone`, {
            otp: phoneOtp,
            expires: Date.now() + 10 * 60 * 1000,
            attempts: 0,
            role
        });

        await this.logSecurityEvent(email, `RECOVERY_PHONE_OTP_SENT_${role.toUpperCase()}`, true, ip);
        return { success: true, message: 'OTP sent to new phone number' };
    }

    async submitRecovery(email: string, newPhone: string, phoneOtp: string, role: 'customer' | 'merchant', ip?: string, device?: string) {
        const isSessionValid = this.otpCache.get(`${role}_${email}_verified`);
        if (!isSessionValid) throw new UnauthorizedException('Session expired');

        const cachedPhone = this.otpCache.get(`${role}_${email}_phone`);
        if (!cachedPhone || cachedPhone.expires < Date.now()) {
            throw new BadRequestException('Phone OTP expired');
        }

        if (cachedPhone.attempts >= 5) {
            throw new UnauthorizedException('Too many failed attempts.');
        }

        if (cachedPhone.otp !== phoneOtp) {
            cachedPhone.attempts += 1;
            throw new BadRequestException(`Invalid OTP. Attempts remaining: ${5 - cachedPhone.attempts}`);
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

            // Clear sessions
            this.otpCache.delete(`${role}_${email}_verified`);
            this.otpCache.delete(`${role}_${email}_phone`);

            await this.logSecurityEvent(email, `RECOVERY_QUEUED_FOR_ADMIN_${role.toUpperCase()}`, true, ip, device);

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

            // TODO: SEND EMAIL NOTIFICATION HERE
            console.log(`[EMAIL NOTIFICATION] To: ${email} -> Your phone number has been updated. Withdrawals are frozen for 12 hours.`);

            // Clear sessions
            this.otpCache.delete(`${role}_${email}_verified`);
            this.otpCache.delete(`${role}_${email}_phone`);

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
        await this.prisma.adminActivityLog.create({
            data: {
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
            }
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
