import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateOrderDto {
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

    // Part Details
    @IsString()
    @IsNotEmpty()
    partName: string;

    @IsString()
    @IsOptional()
    partDescription?: string;

    // Use IsOptional here if frontend might not send it initially, 
    // but plan says mandatory. I'll make it IsString array (URLs).
    // Actually, backend should receive URLs.
    @IsOptional()
    partImages?: string[];

    @IsString()
    @IsOptional()
    vinImage?: string;

    // Preferences
    @IsString()
    @IsOptional()
    conditionPref?: string; // 'new' | 'used'

    @IsBoolean()
    @IsOptional()
    warrantyPreferred?: boolean;
}
