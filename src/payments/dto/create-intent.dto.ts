import { IsNotEmpty, IsString } from 'class-validator';

export class CreateIntentDto {
    @IsNotEmpty()
    @IsString()
    orderId: string;

    @IsNotEmpty()
    @IsString()
    offerId: string;
}
