import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { ViolationTargetType, PenaltyActionType } from '@prisma/client';

export class CreatePenaltyThresholdDto {
  @IsString()
  @IsNotEmpty()
  nameAr: string;

  @IsString()
  @IsNotEmpty()
  nameEn: string;

  @IsEnum(ViolationTargetType)
  @IsNotEmpty()
  targetType: ViolationTargetType;

  @IsInt()
  @Min(1)
  thresholdPoints: number;

  @IsEnum(PenaltyActionType)
  @IsNotEmpty()
  action: PenaltyActionType;

  @IsInt()
  @IsOptional()
  @Min(1)
  suspendDurationDays?: number;
}
