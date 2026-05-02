import { Injectable, NotFoundException, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateMakeDto, UpdateMakeDto, CreateModelDto, UpdateModelDto } from './dto/vehicle-catalog.dto';

@Injectable()
export class VehicleCatalogService {
  private readonly logger = new Logger(VehicleCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  /**
   * PUBLIC: Fetch all active makes
   */
  async getActiveMakes() {
    return this.prisma.vehicleMake.findMany({
      where: { isActive: true },
      include: {
        models: {
          where: { isActive: true },
          select: { id: true, name: true, nameAr: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * ADMIN: Fetch all makes including inactive ones
   */
  async getAllMakesForAdmin() {
    return this.prisma.vehicleMake.findMany({
      include: {
        models: {
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * ADMIN: Create a new make
   */
  async createMake(userId: string, dto: CreateMakeDto) {
    try {
      const make = await this.prisma.vehicleMake.create({
        data: dto,
      });

      await this.auditLogs.logAction({
        actorId: userId,
        actorType: 'ADMIN',
        action: 'CREATE',
        entity: 'VEHICLE_MAKE',
        metadata: { makeId: make.id, name: make.name },
        reason: `Created new vehicle make: ${make.name}`,
      });

      return make;
    } catch (error) {
      if (error.code === 'P2002') {
        throw new ConflictException('A manufacturer with this name already exists');
      }
      throw error;
    }
  }

  /**
   * ADMIN: Update a make (Toggle status or rename)
   */
  async updateMake(userId: string, id: string, dto: UpdateMakeDto) {
    const existing = await this.prisma.vehicleMake.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Manufacturer not found');

    const { signatureData, ...data } = dto;
    const updated = await this.prisma.vehicleMake.update({
      where: { id },
      data,
    });

    await this.auditLogs.logAction({
      actorId: userId,
      actorType: 'ADMIN',
      action: 'UPDATE',
      entity: 'VEHICLE_MAKE',
      metadata: { 
        makeId: id, 
        oldStatus: existing.isActive, 
        newStatus: updated.isActive,
        changes: data,
        signature: signatureData
      },
      actorName: signatureData?.signedName,
      reason: `Updated vehicle make: ${existing.name} (Action by ${signatureData?.signedName || userId})`,
    });

    return updated;
  }

  /**
   * ADMIN: Create a new model
   */
  async createModel(userId: string, dto: CreateModelDto) {
    try {
      const model = await this.prisma.vehicleModel.create({
        data: dto,
      });

      await this.auditLogs.logAction({
        actorId: userId,
        actorType: 'ADMIN',
        action: 'CREATE',
        entity: 'VEHICLE_MODEL',
        metadata: { modelId: model.id, name: model.name, makeId: model.makeId },
        reason: `Created new vehicle model: ${model.name}`,
      });

      return model;
    } catch (error) {
      if (error.code === 'P2002') {
        throw new ConflictException('This model already exists for this manufacturer');
      }
      throw error;
    }
  }

  /**
   * ADMIN: Update a model
   */
  async updateModel(userId: string, id: string, dto: UpdateModelDto) {
    const existing = await this.prisma.vehicleModel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Model not found');

    const { signatureData, ...data } = dto;
    const updated = await this.prisma.vehicleModel.update({
      where: { id },
      data,
    });

    await this.auditLogs.logAction({
      actorId: userId,
      actorType: 'ADMIN',
      action: 'UPDATE',
      entity: 'VEHICLE_MODEL',
      metadata: { 
        modelId: id, 
        oldStatus: existing.isActive, 
        newStatus: updated.isActive,
        changes: data,
        signature: signatureData
      },
      actorName: signatureData?.signedName,
      reason: `Updated vehicle model: ${existing.name} (Action by ${signatureData?.signedName || userId})`,
    });

    return updated;
  }

  /**
   * ADMIN: Toggle all models for a specific make
   */
  async toggleAllModels(userId: string, makeId: string, isActive: boolean, signatureData?: any) {
    const result = await this.prisma.vehicleModel.updateMany({
      where: { makeId },
      data: { isActive },
    });

    await this.auditLogs.logAction({
      actorId: userId,
      actorType: 'ADMIN',
      action: 'UPDATE',
      entity: 'VEHICLE_MODEL_BULK',
      metadata: { makeId, count: result.count, status: isActive, signature: signatureData },
      actorName: signatureData?.signedName,
      reason: `${isActive ? 'Enabled' : 'Disabled'} all models for make ${makeId} (Action by ${signatureData?.signedName || userId})`,
    });

    return result;
  }
}
