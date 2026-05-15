import { IsString, IsNotEmpty, IsOptional, IsIn, IsArray, IsNumber, IsObject } from 'class-validator';
import { Type } from 'class-transformer';

export class CompleteVerificationDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['MATCHING', 'NON_MATCHING'])
  decision: string;

  @IsString()
  @IsOptional()
  reason?: string;

  @IsArray()
  @IsOptional()
  photos?: string[];

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  lat?: number;

  @IsNumber()
  @IsOptional()
  @Type(() => Number)
  lng?: number;

  @IsObject()
  @IsOptional()
  deviceInfo?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsOptional()
  adminSignatureName?: string;

  @IsString()
  @IsOptional()
  adminSignatureImage?: string;
  
  @IsString()
  @IsOptional()
  adminSignatureType?: string;
}
