import { IsEmail, IsNotEmpty, IsString, MinLength, IsOptional, IsEnum, IsNumber, IsArray, ValidateNested } from 'class-validator';
import { UserRole, DocType } from '@prisma/client';
import { Type } from 'class-transformer';

export class VendorDocumentDto {
    @IsEnum(DocType)
    type: DocType;

    @IsString()
    url: string;
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

    @IsOptional()
    @IsEnum(UserRole)
    role?: UserRole;

    // Optional Store Details (for Vendor Role)
    @IsOptional()
    @IsString()
    storeName?: string;

    @IsOptional()
    @IsString()
    category?: string;

    @IsOptional()
    @IsString()
    address?: string;

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
}
