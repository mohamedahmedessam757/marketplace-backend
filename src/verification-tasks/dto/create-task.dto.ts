import { IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateTaskDto {
  @IsUUID()
  @IsNotEmpty()
  orderId: string;

  @IsUUID()
  @IsOptional()
  officerId?: string;

  /** When set, task is scoped to one accepted offer / part */
  @IsUUID()
  @IsOptional()
  offerId?: string;
}
