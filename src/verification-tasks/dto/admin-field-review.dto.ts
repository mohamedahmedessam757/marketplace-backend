import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class AdminFieldReviewDto {
  @IsBoolean()
  approved!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string;
}
