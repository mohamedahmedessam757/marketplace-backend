import { IsString, IsEnum, IsOptional } from 'class-validator';

export enum RiskAlertResolution {
  DISMISSED = 'DISMISSED',
  VIOLATION_ISSUED = 'VIOLATION_ISSUED'
}

export class ResolveRiskAlertDto {
  @IsEnum(RiskAlertResolution)
  resolution: RiskAlertResolution;

  @IsString()
  @IsOptional()
  adminNotes?: string;
}
