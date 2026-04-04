import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { UpdateContractDto } from './dto/update-contract.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@prisma/client';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) {}

  // Public/Vendor accessible to get the current contract during registration
  @Get('active')
  async getActiveContract() {
    return this.contractsService.getActiveVendorContract();
  }

  // Admin only to update the contract
  @Put()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  async updateContract(@Body() updateDto: UpdateContractDto) {
    return this.contractsService.updateVendorContract(updateDto);
  }
}
