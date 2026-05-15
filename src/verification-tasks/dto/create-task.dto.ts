import { IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class CreateTaskDto {
  @IsUUID()
  @IsNotEmpty()
  orderId: string;

  @IsUUID()
  @IsOptional()
  officerId?: string;
}
