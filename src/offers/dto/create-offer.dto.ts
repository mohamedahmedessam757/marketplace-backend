import { IsString, IsNumber, IsBoolean, IsOptional, IsEnum, IsUUID } from 'class-validator';

export class CreateOfferDto {
    @IsUUID()
    orderId: string;

    @IsNumber()
    unitPrice: number;

    @IsNumber()
    weightKg: number;

    @IsString()
    partType: string;

    @IsBoolean()
    hasWarranty: boolean;

    @IsString()
    @IsOptional()
    warrantyDuration?: string;

    @IsString()
    deliveryDays: string; // e.g., 'd1_3'

    @IsString()
    condition: string; // e.g., 'new', 'used_clean'

    @IsString()
    @IsOptional()
    notes?: string;

    @IsString()
    @IsOptional()
    offerImage?: string;
}
