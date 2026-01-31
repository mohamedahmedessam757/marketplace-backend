import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class TransitionOrderDto {
    @IsEnum(OrderStatus)
    newStatus: OrderStatus;

    @IsString()
    @IsOptional()
    reason?: string;

    @IsOptional()
    metadata?: any;
}
