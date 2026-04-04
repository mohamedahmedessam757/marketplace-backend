import { IsUUID, IsEnum, IsOptional, IsString } from 'class-validator';
import { CarrierType } from '@prisma/client';

export class CreateShipmentDto {
    @IsUUID()
    orderId: string;

    @IsOptional()
    @IsUUID()
    waybillId?: string;

    @IsOptional()
    @IsEnum(CarrierType)
    carrierType?: CarrierType;

    @IsOptional()
    @IsString()
    carrierName?: string;

    @IsOptional()
    @IsString()
    trackingNumber?: string;

    @IsOptional()
    @IsString()
    carrierApiUrl?: string;
}
