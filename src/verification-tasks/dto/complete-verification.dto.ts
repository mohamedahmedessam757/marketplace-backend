import { IsString, IsNotEmpty, IsOptional, IsIn, IsArray } from 'class-validator';

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
