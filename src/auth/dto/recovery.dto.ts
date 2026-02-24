import { IsEmail, IsNotEmpty, IsString, Length, IsIn } from 'class-validator';

export class RequestEmailOtpDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsIn(['customer', 'merchant'])
  role: 'customer' | 'merchant';
}

export class VerifyEmailOtpDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @Length(6, 6)
  otp: string;

  @IsString()
  @IsIn(['customer', 'merchant'])
  role: 'customer' | 'merchant';
}

export class RequestPhoneOtpDto {
  @IsEmail()
  @IsNotEmpty()
  email: string; // Used as the identifier for the ongoing session

  @IsString()
  @IsNotEmpty()
  newPhone: string;

  @IsString()
  @IsIn(['customer', 'merchant'])
  role: 'customer' | 'merchant';
}

export class SubmitRecoveryDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  newPhone: string;

  @IsString()
  @Length(6, 6)
  phoneOtp: string;

  @IsString()
  @IsIn(['customer', 'merchant'])
  role: 'customer' | 'merchant';
}
