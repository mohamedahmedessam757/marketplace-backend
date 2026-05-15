import { IsOptional, IsNumber, IsObject } from 'class-validator';

export class StartVerificationDto {
  @IsNumber()
  @IsOptional()
  lat?: number;

  @IsNumber()
  @IsOptional()
  lng?: number;

  @IsObject()
  @IsOptional()
  deviceInfo?: Record<string, any>;
}
