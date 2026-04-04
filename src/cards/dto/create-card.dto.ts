import { IsString, IsInt, Min, Max, Length, IsOptional } from 'class-validator';

export class CreateCardDto {
    @IsString()
    @Length(4, 4)
    last4: string;

    @IsString()
    brand: string;

    @IsInt()
    @Min(1)
    @Max(12)
    expiryMonth: number;

    @IsInt()
    @Min(2000)
    expiryYear: number;

    @IsString()
    @IsOptional()
    cardHolderName?: string;
}
