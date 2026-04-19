import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ViolationTargetType } from '@prisma/client';

export class CreateViolationTypeDto {
  @IsString()
  @IsNotEmpty()
  nameAr: string;

  @IsString()
  @IsNotEmpty()
  nameEn: string;

  @IsString()
  @IsOptional()
  descriptionAr?: string;

  @IsString()
  @IsOptional()
  descriptionEn?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsEnum(ViolationTargetType)
  @IsNotEmpty()
  targetType: ViolationTargetType;

  @IsInt()
  @Min(0)
  points: number;

  @IsNumber()
  @Min(0)
  fineAmount: number;

  @IsInt()
  @Min(1)
  decayDays: number;
}
