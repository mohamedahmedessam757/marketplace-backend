import { IsNotEmpty, IsString } from 'class-validator';

export class DropViolationDto {
  @IsString()
  @IsNotEmpty()
  reason: string;
}
