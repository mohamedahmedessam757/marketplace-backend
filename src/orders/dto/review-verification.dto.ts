import { IsEnum, IsString, IsOptional, IsArray, IsUrl, IsNotEmpty } from 'class-validator';

export enum ReviewAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT'
}

export enum SignatureType {
  DRAWN = 'DRAWN',
  TYPED = 'TYPED'
}

export class ReviewVerificationDto {
  @IsEnum(ReviewAction)
  action: ReviewAction;

  @IsString()
  @IsOptional()
  rejectionReason?: string;

  @IsArray()
  @IsUrl({}, { each: true })
  @IsOptional()
  rejectionImages?: string[];

  @IsString()
  @IsUrl()
  @IsOptional()
  rejectionVideo?: string;

  // New Audit & Signature Fields
  @IsString()
  @IsNotEmpty({ message: 'Admin name is required for signature' })
  adminSignatureName: string;

  @IsEnum(SignatureType)
  adminSignatureType: SignatureType;

  @IsString()
  @IsOptional()
  @IsNotEmpty({ message: 'Signature text is required for typed signature' })
  adminSignatureText?: string;

  @IsString()
  @IsOptional()
  @IsUrl({}, { message: 'Signature image must be a valid URL' })
  @IsNotEmpty({ message: 'Signature image is required for drawn signature' })
  adminSignatureImage?: string;
}
