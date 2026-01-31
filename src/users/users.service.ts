import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcrypt';
import { User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) { }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);

    return this.prisma.$transaction(async (tx) => {
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
}

