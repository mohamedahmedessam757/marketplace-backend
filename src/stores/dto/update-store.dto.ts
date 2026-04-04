import { IsString, IsOptional, IsArray, IsNumber } from 'class-validator';

export class UpdateStoreDto {
    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsString()
    address?: string;

    @IsOptional()
    @IsNumber()
    lat?: number;

    @IsOptional()
    @IsNumber()
    lng?: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    selectedMakes?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    selectedModels?: string[];

    @IsOptional()
    @IsString()
    customMake?: string;

    @IsOptional()
    @IsString()
    customModel?: string;

    @IsOptional()
    @IsString()
    logo?: string;
}
