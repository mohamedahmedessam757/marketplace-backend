import { IsString, IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class CreateMakeDto {
  @IsString()
  name: string;

  @IsString()
  nameAr: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateMakeDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  nameAr?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  // Audit Metadata
  @IsOptional()
  signatureData?: {
    adminSignatureType: 'DRAWN' | 'TYPED';
    adminSignatureText?: string;
    adminSignatureImage?: string;
    signedName: string;
  };
}

export class CreateModelDto {
  @IsUUID()
  makeId: string;

  @IsString()
  name: string;

  @IsString()
  nameAr: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateModelDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  nameAr?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  // Audit Metadata
  @IsOptional()
  signatureData?: {
    adminSignatureType: 'DRAWN' | 'TYPED';
    adminSignatureText?: string;
    adminSignatureImage?: string;
    signedName: string;
  };
}
