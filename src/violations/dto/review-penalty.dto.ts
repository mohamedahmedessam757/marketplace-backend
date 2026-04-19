import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PenaltyActionStatus } from '@prisma/client';

export class ReviewPenaltyDto {
  @IsEnum(PenaltyActionStatus)
  @IsNotEmpty()
  status: PenaltyActionStatus;

  @IsString()
  @IsOptional()
  adminNotes?: string;
}
