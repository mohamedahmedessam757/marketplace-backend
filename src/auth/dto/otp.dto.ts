import { IsEmail, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

export class RegisterVerifyOtpDto {
    @IsEmail()
    email: string;

    @IsString()
    phone: string;

    @IsString()
    @Length(6, 6)
    @Matches(/^\d{6}$/)
    code: string;
}

export class RegisterResendOtpDto {
    @IsEmail()
    email: string;

    @IsString()
    phone: string;

    @IsOptional()
    @IsString()
    name?: string;
}

export class MobileLoginResendOtpDto {
    @IsString()
    phone: string;
}

export class OtpVerifyDto {
    @IsString()
    phone: string;

    @IsString()
    @Length(6, 6)
    @Matches(/^\d{6}$/)
    code: string;
}
