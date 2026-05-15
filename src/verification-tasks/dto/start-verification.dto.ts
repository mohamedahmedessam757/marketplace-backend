import { IsOptional, IsNumber, IsObject, IsBoolean } from 'class-validator';

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

  /** Local/dev only: skip GPS when browser blocks geolocation (non-HTTPS). */
  @IsBoolean()
  @IsOptional()
  gpsDevBypass?: boolean;
}
