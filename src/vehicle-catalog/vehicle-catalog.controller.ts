import { Controller, Get, Post, Patch, Body, Param, UseGuards, Request } from '@nestjs/common';
import { VehicleCatalogService } from './vehicle-catalog.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { UserRole } from '@prisma/client';
import { CreateMakeDto, UpdateMakeDto, CreateModelDto, UpdateModelDto } from './dto/vehicle-catalog.dto';

@Controller('vehicle-catalog')
export class VehicleCatalogController {
  constructor(private readonly catalogService: VehicleCatalogService) {}

  /**
   * PUBLIC: Get all active makes and models for order creation/registration
   */
  @Get('active')
  async getActive() {
    return this.catalogService.getActiveMakes();
  }

  /**
   * ADMIN: Get full catalog
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('settings', 'view')
  @Get('admin/all')
  async getAllForAdmin() {
    return this.catalogService.getAllMakesForAdmin();
  }

  /**
   * ADMIN: Create new manufacturer
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('settings', 'edit')
  @Post('admin/makes')
  async createMake(@Request() req, @Body() dto: CreateMakeDto) {
    return this.catalogService.createMake(req.user.id, dto);
  }

  /**
   * ADMIN: Update manufacturer (Toggle status/Rename)
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('settings', 'edit')
  @Patch('admin/makes/:id')
  async updateMake(@Request() req, @Param('id') id: string, @Body() dto: UpdateMakeDto) {
    return this.catalogService.updateMake(req.user.id, id, dto);
  }

  /**
   * ADMIN: Create new model for a manufacturer
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('settings', 'edit')
  @Post('admin/models')
  async createModel(@Request() req, @Body() dto: CreateModelDto) {
    return this.catalogService.createModel(req.user.id, dto);
  }

  /**
   * ADMIN: Update model
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('settings', 'edit')
  @Patch('admin/models/:id')
  async updateModel(@Request() req, @Param('id') id: string, @Body() dto: UpdateModelDto) {
    return this.catalogService.updateModel(req.user.id, id, dto);
  }

  /**
   * ADMIN: Bulk toggle models for a make
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @Permissions('settings', 'edit')
  @Patch('admin/makes/:id/toggle-models')
  async toggleAllModels(
    @Request() req,
    @Param('id') id: string,
    @Body() body: { 
      isActive: boolean;
      signatureData?: {
        adminSignatureType: 'DRAWN' | 'TYPED';
        adminSignatureText?: string;
        adminSignatureImage?: string;
        signedName: string;
      };
    }
  ) {
    return this.catalogService.toggleAllModels(req.user.id, id, body.isActive, body.signatureData);
  }
}
