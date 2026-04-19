import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AppealStatus } from '@prisma/client';

export class ReviewAppealDto {
  @IsEnum(AppealStatus)
  @IsNotEmpty()
  status: AppealStatus;

  @IsString()
  @IsOptional()
  adminResponse?: string;
}
