import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { ContractsService } from './contracts.service';
import { UpdateContractDto } from './dto/update-contract.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { UserRole } from '@prisma/client';

@Controller('contracts')
export class ContractsController {
  constructor(private readonly contractsService: ContractsService) { }

  // Public/Vendor accessible to get the current contract during registration
  @Get('active')
  async getActiveContract() {
    return this.contractsService.getActiveVendorContract();
  }

  // Admin only to update the contract
  @Put()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('contracts', 'edit')
  async updateContract(@Body() updateDto: UpdateContractDto) {
    return this.contractsService.updateVendorContract(updateDto);
  }
}
