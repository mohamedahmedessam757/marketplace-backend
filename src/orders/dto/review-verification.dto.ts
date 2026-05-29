import { IsEnum, IsString, IsOptional, IsArray, IsUrl, IsNotEmpty, IsUUID } from 'class-validator';

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

  /** Target verification document (per-part review). */
  @IsOptional()
  @IsUUID()
  documentId?: string;

  /** Target offer when reviewing a specific part. */
  @IsOptional()
  @IsUUID()
  offerId?: string;

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

  @IsString()
  @IsNotEmpty({ message: 'Admin name is required for signature' })
  adminSignatureName: string;

  @IsEnum(SignatureType)
  adminSignatureType: SignatureType;

  @IsString()
  @IsOptional()
  adminSignatureText?: string;

  @IsString()
  @IsOptional()
  adminSignatureImage?: string;
}
