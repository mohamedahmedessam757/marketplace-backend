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
        const incomingReferralCode = (createUserDto as any).referralCode;
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
        orders: {
          include: {
            acceptedOffer: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return customers.map(user => {
      const totalOrders = user.orders.length;
      const completedOrders = user.orders.filter(o => ['COMPLETED', 'DELIVERED'].includes(o.status));
      const successRate = totalOrders > 0 ? Math.round((completedOrders.length / totalOrders) * 100) : 0;

      const ltv = completedOrders.reduce((sum, order) => {
        const base = Number(order.acceptedOffer?.unitPrice || 0);
        const shipping = Number(order.acceptedOffer?.shippingCost || 0);
        const commission = base > 0 ? Math.max(Math.round(base * 0.25), 100) : 0;
        return sum + base + shipping + commission;
      }, 0);

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        status: user.status || 'ACTIVE',
        joinedAt: user.createdAt,
        ltv,
        successRate,
        ordersCount: totalOrders,
        adminNotes: user.adminNotes || ''
      };
    });
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
            }
          },
          orderBy: { createdAt: 'desc' }
        },
        disputes: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!user) return null;

    const totalOrders = user.orders.length;
    const completedOrders = user.orders.filter(o => ['COMPLETED', 'DELIVERED'].includes(o.status));
    const successRate = totalOrders > 0 ? Math.round((completedOrders.length / totalOrders) * 100) : 0;
    const ltv = completedOrders.reduce((sum, order) => {
      const base = Number(order.acceptedOffer?.unitPrice || 0);
      const shipping = Number(order.acceptedOffer?.shippingCost || 0);
      const commission = base > 0 ? Math.max(Math.round(base * 0.25), 100) : 0;
      return sum + base + shipping + commission;
    }, 0);

    return {
      ...user,
      ltv,
      successRate,
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

  async adminToggleStatus(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return null;

    const currentStatus = user.status || 'ACTIVE';
    const newStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';

    return this.prisma.user.update({
      where: { id },
      data: { status: newStatus }
    });
  }
}

