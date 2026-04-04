import { IsNotEmpty, IsString, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class CardDto {
    @IsNotEmpty()
    @IsString()
    number: string;

    @IsNotEmpty()
    @IsString()
    expiry: string;

    @IsNotEmpty()
    @IsString()
    cvv: string;

    @IsNotEmpty()
    @IsString()
    holder: string;
}

export class ProcessPaymentDto {
    @IsNotEmpty()
    @IsString()
    orderId: string;

    @IsNotEmpty()
    @IsString()
    offerId: string;

    @ValidateNested()
    @Type(() => CardDto)
    card: CardDto;
}
