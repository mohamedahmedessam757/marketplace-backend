import { IsOptional, IsString, IsNumber, IsArray, MaxLength } from 'class-validator';

export class UpdateStoreDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  logo?: string;

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
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  selectedMakes?: string[];

  @IsOptional()
  @IsArray()
  selectedModels?: string[];

  @IsOptional()
  @IsString()
  customMake?: string;

  @IsOptional()
  @IsString()
  customModel?: string;
}
