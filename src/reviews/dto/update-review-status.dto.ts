import { IsString, IsEnum, IsNotEmpty } from 'class-validator';

export enum ReviewAdminStatus {
  PENDING = 'PENDING',
  PUBLISHED = 'PUBLISHED',
  REJECTED = 'REJECTED'
}

export class UpdateReviewStatusDto {
  @IsEnum(ReviewAdminStatus)
  @IsNotEmpty()
  status: ReviewAdminStatus;
}
