import {
  IsArray,
  IsEnum,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum WaybillIssueMode {
  PER_PART = 'per_part',
  SINGLE_BATCH = 'single_batch',
  CUSTOM = 'custom',
}

export class WaybillOfferGroupDto {
  @IsArray()
  @IsUUID('4', { each: true })
  offerIds: string[];
}

export class IssueWaybillDto {
  @IsEnum(WaybillIssueMode)
  mode: WaybillIssueMode;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  offerIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WaybillOfferGroupDto)
  groups?: WaybillOfferGroupDto[];
}
