import { IsString, IsNumber, IsOptional, IsEnum, Min, IsEmail } from 'class-validator';

export enum PayoutMethod {
    MANUAL = 'MANUAL',
    STRIPE_CONNECT = 'STRIPE_CONNECT'
}

export class AdminManualPayoutDto {
    @IsString()
    userId: string;

    @IsNumber()
    @Min(1)
    amount: number;

    @IsOptional()
    @IsString()
    note?: string;

    @IsString()
    adminName: string;

    @IsEmail()
    adminEmail: string;

    @IsString()
    adminSignature: string;

    @IsEnum(PayoutMethod)
    @IsOptional()
    method?: PayoutMethod;
}
