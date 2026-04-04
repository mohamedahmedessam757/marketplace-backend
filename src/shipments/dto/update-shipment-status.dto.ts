import { IsEnum, IsOptional, IsString, IsUrl } from 'class-validator';
import { CarrierType } from '@prisma/client';

// We use a string enum here that matches ShipmentStatus values.
// After prisma generate runs, these will be enforced by the Prisma-generated enum.
export class UpdateShipmentStatusDto {
    @IsString()
    status: string; // ShipmentStatus - validated at service layer

    @IsOptional()
    @IsString()
    notes?: string;

    @IsOptional()
    @IsString()
    customsDelayNote?: string;

    @IsOptional()
    @IsString()
    carrierName?: string;

    @IsOptional()
    @IsString()
    trackingNumber?: string;

    @IsOptional()
    @IsUrl({}, { message: 'Invalid carrier API URL' })
    carrierApiUrl?: string;

    @IsOptional()
    @IsEnum(CarrierType)
    carrierType?: CarrierType;

    @IsOptional()
    @IsString()
    estimatedDelivery?: string; // ISO date string
}
