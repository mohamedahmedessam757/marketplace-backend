import { IsOptional, IsNumber, IsBoolean, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateOfferDto {
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    unitPrice?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    weightKg?: number;

    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    shippingCost?: number;

    @IsOptional()
    @IsBoolean()
    hasWarranty?: boolean;

    @IsOptional()
    @IsString()
    warrantyDuration?: string;

    @IsOptional()
    @IsString()
    deliveryDays?: string;

    @IsOptional()
    @IsString()
    condition?: string;

    @IsOptional()
    @IsString()
    partType?: string;

    @IsOptional()
    @IsString()
    notes?: string;

    @IsOptional()
    @IsString()
    offerImage?: string;
}
