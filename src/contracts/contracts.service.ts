import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateContractDto } from './dto/update-contract.dto';

@Injectable()
export class ContractsService {
  constructor(private prisma: PrismaService) {}

  async getActiveVendorContract() {
    let contract = await this.prisma.platformContract.findFirst({
      where: { type: 'vendor_agreement', isActive: true },
      orderBy: { version: 'desc' },
    });

    if (!contract) {
      // Fallback if the user hasn't run the SQL script or it's empty
      return {
        id: null,
        titleAr: 'عقد استضافة متجر إلكتروني',
        titleEn: 'E-Commerce Store Hosting Agreement',
        contentAr: '',
        contentEn: '',
        firstPartyConfig: {},
        version: 1
      };
    }

    return contract;
  }

  async updateVendorContract(updateDto: UpdateContractDto) {
    // We create a new version instead of overwriting, to maintain history
    // Get current version
    const current = await this.prisma.platformContract.findFirst({
      where: { type: 'vendor_agreement' },
      orderBy: { version: 'desc' },
    });

    const newVersion = current ? current.version + 1 : 1;

    // Deactivate old contracts
    await this.prisma.platformContract.updateMany({
      where: { type: 'vendor_agreement' },
      data: { isActive: false },
    });

    // Create new contract
    return this.prisma.platformContract.create({
      data: {
        type: 'vendor_agreement',
        contentAr: updateDto.contentAr,
        contentEn: updateDto.contentEn,
        firstPartyConfig: updateDto.firstPartyConfig || {},
        version: newVersion,
        isActive: true,
      },
    });
  }
}
