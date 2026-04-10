import { IsEmail, IsNotEmpty, IsString, MinLength, IsOptional, IsEnum, IsNumber, IsArray, ValidateNested, IsObject } from 'class-validator';
import { UserRole, DocType } from '@prisma/client';
import { Type } from 'class-transformer';

export class VendorDocumentDto {
    @IsEnum(DocType)
    type: DocType;

    @IsString()
    url: string;
}

export class ContractDataDto {
    @IsString()
    contractId: string;

    @IsNumber()
    contractVersion: number;

    @IsOptional()
    secondPartyData?: any;

    @IsOptional()
    signatureData?: any;

    @IsOptional()
    firstPartySnapshot?: any;

    @IsString()
    contentArSnapshot: string;

    @IsString()
    contentEnSnapshot: string;

    @IsOptional()
    @IsString()
    ipAddress?: string;

    @IsOptional()
    @IsString()
    userAgent?: string;
}

export class CreateUserDto {
    @IsEmail()
    email: string;

    @IsString()
    @MinLength(6)
    password: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsOptional()
    phone?: string;

    @IsString()
    @IsOptional()
    countryCode?: string;

    @IsString()
    @IsOptional()
    country?: string;

    @IsOptional()
    @IsEnum(UserRole)
    role?: UserRole;

    // Optional Store Details (for Vendor Role)
    @IsOptional()
    @IsString()
    storeName?: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsString()
    category?: string;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    selectedMakes?: string[];

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    selectedModels?: string[];

    @IsOptional()
    @IsString()
    customMake?: string;

    @IsOptional()
    @IsString()
    customModel?: string;

    @IsOptional()
    @IsString()
    address?: string;

    @IsOptional()
    @IsString()
    contractId?: string;

    @IsOptional()
    @IsNumber()
    lat?: number;

    @IsOptional()
    @IsNumber()
    lng?: number;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => VendorDocumentDto)
    documents?: VendorDocumentDto[];

    @IsOptional()
    @ValidateNested()
    @Type(() => ContractDataDto)
    contractData?: ContractDataDto;

    // Referral System: Code from the referring user (used at registration)
    @IsOptional()
    @IsString()
    referralCode?: string;
}

