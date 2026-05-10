import { IsEnum, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { ViolationSource, ViolationTargetType } from '@prisma/client';

export class IssueViolationDto {
  @IsUUID()
  @IsNotEmpty()
  typeId: string;

  @IsUUID()
  @IsNotEmpty()
  targetUserId: string;

  @IsUUID()
  @IsOptional()
  targetStoreId?: string;

  @IsEnum(ViolationTargetType)
  @IsNotEmpty()
  targetType: ViolationTargetType;

  @IsString()
  @IsOptional()
  adminNotes?: string;

  @IsUUID()
  @IsOptional()
  orderId?: string;

  @IsInt()
  @IsOptional()
  @Min(0)
  customPoints?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  customFineAmount?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  customDecayDays?: number;

  /** Internal flag: SYSTEM auto-issue vs MANUAL admin issue. Defaults to MANUAL. */
  @IsEnum(ViolationSource)
  @IsOptional()
  source?: ViolationSource;

  /** Internal idempotency key (used by autoIssue). When set, duplicate violations are ignored. */
  @IsString()
  @IsOptional()
  uniqueKey?: string;
}
