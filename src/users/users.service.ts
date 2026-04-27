import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import { User } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService
  ) { }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Generate unique referral code
        let referralCode = '';
        let isUniqueCode = false;
        while (!isUniqueCode) {
          referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
          const existing = await tx.user.findUnique({ where: { referralCode } });
          if (!existing) isUniqueCode = true;
        }

        // Resolve Referrer
        let referredById: string | null = null;
        const incomingReferralCode = createUserDto.referralCode;
        if (incomingReferralCode) {
          console.log(`[UsersService] Referral code received: '${incomingReferralCode}' for new user: ${createUserDto.email}`);
          const referrer = await tx.user.findUnique({ 
            where: { referralCode: incomingReferralCode } 
          });
          if (referrer) {
            referredById = referrer.id;
            console.log(`[UsersService] Referral LINKED. New user will be linked to referrer: ${referrer.id} (${referrer.email})`);
          } else {
            console.warn(`[UsersService] Referral code '${incomingReferralCode}' NOT FOUND in database. Skipping referral link.`);
          }
        }

        const user = await tx.user.create({
          data: {
            passwordHash: hashedPassword,
            email: createUserDto.email,
            name: createUserDto.name,
            phone: createUserDto.phone,
            countryCode: createUserDto.countryCode,
            country: createUserDto.country,
            role: createUserDto.role || 'CUSTOMER',
            referralCode,
            referredById,
          },
        });

        // Increment referralCount on the referrer immediately upon successful registration
        // (Financial reward/points fire later via processReferralReward after first order closed)
        if (referredById) {
          await tx.user.update({
            where: { id: referredById },
            data: { referralCount: { increment: 1 } }
          });
          
          // Notify the referrer with a "Premium" congratulatory message
          this.notificationsService.create({
            recipientId: referredById,
            recipientRole: 'CUSTOMER', // Referrals are for customers/users
            type: 'referral',
            titleAr: 'إحالة ناجحة! 🎉',
            titleEn: 'Successful Referral! 🎉',
            messageAr: `خبر رائع! لقد انضم عضو جديد للمنصة من خلال رابطك الخاص. أنت الآن أقرب لربح مكافآتك القادمة، شكراً لمساندتك لنا! 🌟`,
            messageEn: `Great news! A new member has joined using your link. You're now one step closer to your next reward. Thanks for sharing the success! 🌟`,
            link: '/dashboard/wallet'
          }).catch(err => console.error('Failed to send referral notification:', err));

          console.log(`[UsersService] Referral notification sent and count incremented for referrer: ${referredById}`);
        }

        // If user is a VENDOR, create a Store record immediately
        if (createUserDto.role === 'VENDOR') {
          // Generate a unique store code
          let generatedStoreCode = '';
          let isUnique = false;
          while (!isUnique) {
            generatedStoreCode = 'D-' + String(Math.floor(1000 + Math.random() * 9000));
            const existing = await tx.store.findUnique({ where: { storeCode: generatedStoreCode } });
            if (!existing) isUnique = true;
          }

          const store = await tx.store.create({
            data: {
              ownerId: user.id,
              name: createUserDto.storeName || `${createUserDto.name}'s Store`,
              description: createUserDto.description,
              storeCode: generatedStoreCode,
              status: 'PENDING_DOCUMENTS',
              address: createUserDto.address,
              lat: createUserDto.lat,
              lng: createUserDto.lng,
              category: createUserDto.category,
              selectedMakes: createUserDto.selectedMakes || [],
              selectedModels: createUserDto.selectedModels || [],
              customMake: createUserDto.customMake || null,
              customModel: createUserDto.customModel || null,
              contractId: createUserDto.contractData?.contractId || createUserDto.contractId || null,
              contractAcceptedAt: (createUserDto.contractData || createUserDto.contractId) ? new Date() : null,
            }
          });

          // Create Contract Acceptance if data provided
          if (createUserDto.contractData) {
            await tx.contractAcceptance.create({
              data: {
                storeId: store.id,
                contractId: createUserDto.contractData.contractId,
                contractVersion: createUserDto.contractData.contractVersion,
                secondPartyData: createUserDto.contractData.secondPartyData || {},
                signatureData: createUserDto.contractData.signatureData || {},
                firstPartySnapshot: createUserDto.contractData.firstPartySnapshot || {},
                contentArSnapshot: createUserDto.contractData.contentArSnapshot,
                contentEnSnapshot: createUserDto.contractData.contentEnSnapshot,
                ipAddress: createUserDto.contractData.ipAddress,
                userAgent: createUserDto.contractData.userAgent,
                acceptedAt: new Date()
              }
            });
          }

          // Create Store Documents if provided
          if (createUserDto.documents && createUserDto.documents.length > 0) {
            await tx.storeDocument.createMany({
              data: createUserDto.documents.map(doc => ({
                storeId: store.id,
                docType: doc.type,
                fileUrl: doc.url,
                status: 'pending'
              }))
            });
          }
        }

        return user;
      });
    } catch (error) {
      if (error.code === 'P2002') {
        if (error.meta?.target?.includes('phone')) {
          throw new ConflictException('Phone number already exists');
        }
        if (error.meta?.target?.includes('email')) {
          throw new ConflictException('Email already exists');
        }
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByPhone(phone: string): Promise<User | null> {
    // Normalize phone input to handle different formats query
    // detailed logic:
    // 1. If starts with +966, try also 05... and 966...
    // 2. If starts with 05, try also +966... and 966...
    // 3. effective way is to strip everything and search OR search by multiple known formats.

    // Let's assume input 'phone' is what frontend sent (e.g. +966500000000)
    // We want to find if this user exists stored as '0500000000' or '966500000000' or '+966500000000'

    let possibleFormats = [phone];

    // Clean string
    const clean = phone.replace(/\D/g, ''); // 966500000000

    // Generic Common Formats
    if (!possibleFormats.includes(clean)) possibleFormats.push(clean);

    // GCC Specific Logic (Saudi, UAE, Bahrain, Qatar, Kuwait, Oman)
    const prefixes = ['966', '971', '973', '974', '965', '968'];

    // Check if input starts with any GCC prefix
    for (const prefix of prefixes) {
      if (clean.startsWith(prefix)) {
        // Case 1: Input is International (9665...)
        // Try Local Format (e.g. 05...)
        const withoutPrefix = clean.substring(prefix.length);
        const local = '0' + withoutPrefix;
        const localNoZero = withoutPrefix;

        if (!possibleFormats.includes(local)) possibleFormats.push(local);
        if (!possibleFormats.includes(localNoZero)) possibleFormats.push(localNoZero);

        // Try International with +
        const withPlus = '+' + clean;
        if (!possibleFormats.includes(withPlus)) possibleFormats.push(withPlus);

        break; // Match found
      }
    }

    // Heuristic: If starts with 5 (likely Saudi/UAE missing prefix or zero)
    if (clean.startsWith('5')) {
      // 1. Try adding 0 -> 05...
      const withZero = '0' + clean;
      if (!possibleFormats.includes(withZero)) possibleFormats.push(withZero);

      // 2. Try adding GCC prefixes (Most likely Saudi 966)
      const saudi = '966' + clean;
      // Add more if needed, but Saudi is dominant

      if (!possibleFormats.includes(saudi)) possibleFormats.push(saudi);
      if (!possibleFormats.includes('+' + saudi)) possibleFormats.push('+' + saudi);
    }

    // Heuristic: If starts with 05 (Local)
    if (clean.startsWith('05')) {
      const withoutZero = clean.substring(1); // 5...
      // Try adding 966 to 5...
      const saudiIntl = '966' + withoutZero;
      if (!possibleFormats.includes(saudiIntl)) possibleFormats.push(saudiIntl);
      if (!possibleFormats.includes('+' + saudiIntl)) possibleFormats.push('+' + saudiIntl);
    }

    console.log(`[Auth Debug] Phone Search: Input='${phone}', Clean='${clean}', FormatsChecked=`, possibleFormats);

    // Use findFirst with OR
    return this.prisma.user.findFirst({
      where: {
        phone: { in: possibleFormats }
      },
    });
  }

  async findByIdWithStore(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            status: true,
            licenseExpiry: true,
          }
        }
      }
    });
  }

  async update(id: string, data: { name?: string; phone?: string; avatar?: string }) {
    const user = await this.prisma.user.update({
      where: { id },
      data: data
    });

    // Notify user of profile update (Security Alert)
    this.notificationsService.create({
      recipientId: id,
      recipientRole: user.role, // Dispatched dynamically
      titleAr: 'تحديث الحساب (تنبيه أمني)',
      titleEn: 'Account Updated (Security Alert)',
      messageAr: 'تم تحديث بيانات ملفك الشخصي بنجاح. إذا لم تكن أنت، يرجى تغيير كلمة المرور.',
      messageEn: 'Your profile has been updated. If this was not you, please change your password.',
      type: 'SYSTEM',
      link: '/dashboard/profile' // Generic link, router handles it
    }).catch(e => console.error('Failed to dispatch profile update alert', e));

    return user;
  }

  // --- Administrative Methods (v2026 Ready) ---

  async adminFindAllCustomers() {
    const customers = await this.prisma.user.findMany({
      where: { role: 'CUSTOMER' },
      include: {
        orders: true,
        payments: {
          where: { status: 'SUCCESS' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return customers.map(user => {
      const totalOrders = user.orders.length;
      const completedOrders = user.orders.filter(o => ['COMPLETED', 'DELIVERED'].includes(o.status));
      const successRate = totalOrders > 0 ? Math.round((completedOrders.length / totalOrders) * 100) : 0;

      // Calculate LTV objectively from successful payments
      const ltv = user.payments.reduce((sum, payment) => sum + Number(payment.totalAmount || 0), 0);

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        status: user.status || 'ACTIVE',
        joinedAt: user.createdAt,
        avatar: user.avatar,
        ltv,
        successRate,
        ordersCount: totalOrders,
        adminNotes: user.adminNotes || ''
      };
    });
  }

  async adminSearchEntities(query: string) {
    if (!query || query.length < 2) return [];
    
    // Precise UUID check for conditional ID fetching
    const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(query);

    // 1. Fetch users by text fields
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ]
      },
      take: 5,
      select: { 
        id: true, 
        name: true, 
        email: true, 
        phone: true, 
        role: true 
      }
    });

    // 2. If it's a UUID, fetch direct user match separately to avoid Prisma type conflicts
    if (isUuid) {
      const directUser = await this.prisma.user.findUnique({
        where: { id: query },
        select: { id: true, name: true, email: true, phone: true, role: true }
      });
      if (directUser) users.push(directUser);
    }

    // 3. Fetch stores by text fields
    const stores = await this.prisma.store.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { storeCode: { contains: query, mode: 'insensitive' } },
        ]
      },
      take: 5,
      select: { 
        id: true, 
        name: true, 
        storeCode: true,
        owner: { 
          select: { 
            id: true,
            email: true,
            phone: true
          } 
        } 
      }
    });

    const results = [
      ...users.map(u => ({ 
        id: u.id, 
        name: u.name || u.email.split('@')[0], 
        email: u.email,
        phone: u.phone,
        type: u.role === 'VENDOR' ? 'MERCHANT' : 'CUSTOMER' 
      })),
      ...stores.map(s => ({ 
        id: s.owner?.id || s.id, 
        name: s.name, 
        email: s.owner?.email,
        phone: s.owner?.phone,
        type: 'MERCHANT',
        storeCode: s.storeCode
      }))
    ];

    // Deduplicate by ID
    return results.filter((v, i, a) => a.findIndex(t => (t.id === v.id)) === i);
  }

  async adminFindCustomerById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        Session: {
          orderBy: { lastActive: 'desc' },
          take: 10
        },
        securityLogs: {
          orderBy: { createdAt: 'desc' },
          take: 10
        },
        orders: {
          include: {
            acceptedOffer: {
              include: { store: true }
            },
            parts: {
              include: {
                offers: {
                  where: { status: 'accepted' }
                }
              }
            },
            payments: true,
            offers: {
              where: { status: 'accepted' }
            }
          },
          orderBy: { createdAt: 'desc' }
        },
        returns: {
          include: {
            order: true
          },
          orderBy: { createdAt: 'desc' }
        },
        disputes: {
          include: {
            order: true
          },
          orderBy: { createdAt: 'desc' }
        },
        payments: {
          include: {
            order: {
              select: { id: true, orderNumber: true, status: true }
            }
          },
          orderBy: { createdAt: 'desc' }
        },
        walletTransactions: {
          include: { payment: true },
          orderBy: { createdAt: 'desc' }
        },
        withdrawalRequests: {
          orderBy: { createdAt: 'desc' }
        },
        _count: {
          select: {
            violations: true,
            disputes: true,
            orders: true,
            referredUsers: true,
            invoices: true,
            returns: true
          }
        }
      }
    });

    if (!user) return null;

    const totalOrders = user.orders.length;
    const completedOrders = user.orders.filter(o => ['COMPLETED', 'DELIVERED'].includes(o.status));
    const successRate = totalOrders > 0 ? Math.round((completedOrders.length / totalOrders) * 100) : 0;
    
    // Calculate LTV/TotalSpent objectively from successful payments
    const successfulPayments = await this.prisma.paymentTransaction.findMany({
      where: { customerId: id, status: 'SUCCESS' }
    });
    const ltv = successfulPayments.reduce((sum, payment) => sum + Number(payment.totalAmount || 0), 0);

    // Calculate real-time Violation Score from active records (2026 integrity standard)
    const activeViolations = await this.prisma.violation.findMany({
      where: { targetUserId: id, status: 'ACTIVE' }
    });
    const violationScore = activeViolations.reduce((sum, v) => sum + v.points, 0);

    return {
      ...user,
      ltv,
      totalSpent: ltv, // Consistency for 2026 platform standards
      successRate,
      violationScore,
      status: user.status || 'ACTIVE',
      adminNotes: user.adminNotes || ''
    };
  }

  async adminUpdateNotes(id: string, notes: string) {
    return this.prisma.user.update({
      where: { id },
      data: { adminNotes: notes }
    });
  }

  async adminUpdateStatus(id: string, status: 'ACTIVE' | 'SUSPENDED', reason?: string) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Update User Record
      const user = await tx.user.update({
        where: { id },
        data: { 
          status,
          suspendReason: status === 'SUSPENDED' ? reason : null
        }
      });

      // 2. Precise Administrative Audit Log (2026 Security Standard)
      await tx.auditLog.create({
        data: {
          action: status === 'SUSPENDED' ? 'USER_BAN' : 'USER_ACTIVATE',
          entity: 'USER',
          actorType: 'ADMIN',
          actorId: id,
          reason: reason || 'Administrative status toggle',
          newState: status,
          metadata: {
            adminAction: true,
            timestamp: new Date().toISOString()
          }
        }
      });

      return user;
    });
  }

  async adminUpdateCustomer(id: string, data: { name?: string; email?: string; country?: string; phone?: string }) {
    return this.prisma.user.update({
      where: { id },
      data: {
        ...data,
        updatedAt: new Date()
      }
    });
  }
}

