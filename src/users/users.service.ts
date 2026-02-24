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
        const user = await tx.user.create({
          data: {
            passwordHash: hashedPassword,
            email: createUserDto.email,
            name: createUserDto.name,
            phone: createUserDto.phone,
            role: createUserDto.role || 'CUSTOMER',
          },
        });

        // If user is a VENDOR, create a Store record immediately
        if (createUserDto.role === 'VENDOR') {
          const store = await tx.store.create({
            data: {
              ownerId: user.id,
              name: createUserDto.storeName || `${createUserDto.name}'s Store`,
              status: 'PENDING_DOCUMENTS',
              address: createUserDto.address,
              lat: createUserDto.lat,
              lng: createUserDto.lng,
              category: createUserDto.category
            }
          });

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
}

