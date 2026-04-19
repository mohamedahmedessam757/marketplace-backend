import { PartialType } from '@nestjs/mapped-types';
import { CreatePenaltyThresholdDto } from './create-penalty-threshold.dto';

export class UpdatePenaltyThresholdDto extends PartialType(CreatePenaltyThresholdDto) {}
