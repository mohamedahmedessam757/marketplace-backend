import { IsString, IsNumber, Min, Max, IsOptional, IsBoolean, IsNotEmpty, IsInt } from 'class-validator';

export class CreateRatingImpactRuleDto {
  @IsNumber()
  @Min(0)
  @Max(5)
  @IsNotEmpty()
  minRating: number;

  @IsNumber()
  @Min(0)
  @Max(5)
  @IsNotEmpty()
  maxRating: number;

  @IsString()
  @IsNotEmpty()
  actionType: string; // SUSPEND, WARNING, FEATURED, NONE

  @IsString()
  @IsNotEmpty()
  actionLabelAr: string;

  @IsString()
  @IsNotEmpty()
  actionLabelEn: string;

  @IsInt()
  @IsOptional()
  suspendDurationDays?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateRatingImpactRuleDto {
  @IsNumber()
  @Min(0)
  @Max(5)
  @IsOptional()
  minRating?: number;

  @IsNumber()
  @Min(0)
  @Max(5)
  @IsOptional()
  maxRating?: number;

  @IsString()
  @IsOptional()
  actionType?: string;

  @IsString()
  @IsOptional()
  actionLabelAr?: string;

  @IsString()
  @IsOptional()
  actionLabelEn?: string;

  @IsInt()
  @IsOptional()
  suspendDurationDays?: number;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
