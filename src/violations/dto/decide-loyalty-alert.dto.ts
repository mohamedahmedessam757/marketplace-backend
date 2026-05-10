import { IsEnum, IsOptional, IsString } from 'class-validator';

export enum LoyaltyAlertDecision {
  CANCEL_REWARDS = 'CANCEL_REWARDS',
  KEEP_REWARDS = 'KEEP_REWARDS',
}

export class DecideLoyaltyAlertDto {
  @IsEnum(LoyaltyAlertDecision)
  decision: LoyaltyAlertDecision;

  @IsString()
  @IsOptional()
  adminNotes?: string;
}
