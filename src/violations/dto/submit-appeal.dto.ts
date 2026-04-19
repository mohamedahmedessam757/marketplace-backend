import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SubmitAppealDto {
  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  evidenceUrls?: string[];
}
