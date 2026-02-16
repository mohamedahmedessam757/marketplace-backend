import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Min, ValidateNested, IsArray, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOrderPartDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsOptional()
    description?: string;

    @IsString()
    @IsOptional()
    notes?: string;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    images?: string[];

    @IsString()
    @IsOptional()
    video?: string;
}


export class CreateOrderDto {
    // Top-level fields from Frontend Store
    @IsString()
    @IsOptional()
    requestType?: string;

    @IsString()
    @IsOptional()
    shippingType?: string;

    // Vehicle Details (required)
    @IsString()
    @IsNotEmpty()
    vehicleMake: string;

    @IsString()
    @IsNotEmpty()
    vehicleModel: string;

    @IsNumber()
    @Min(1900)
    vehicleYear: number;

    @IsString()
    @IsOptional()
    vin?: string;

    @IsString()
    @IsOptional()
    vinImage?: string;

    // Part Details - Multi-part support
    @IsArray()
    @ValidateNested({ each: true })
    @ArrayMinSize(1)
    @Type(() => CreateOrderPartDto)
    parts: CreateOrderPartDto[];

    // Legacy fields for backward compatibility (Optional now)
    @IsString()
    @IsOptional()
    partName?: string;

    @IsString()
    @IsOptional()
    partDescription?: string;

    @IsOptional()
    partImages?: string[];

    // Preferences
    @IsString()
    @IsOptional()
    conditionPref?: string; // 'new' | 'used'

    @IsBoolean()
    @IsOptional()
    warrantyPreferred?: boolean;
}
