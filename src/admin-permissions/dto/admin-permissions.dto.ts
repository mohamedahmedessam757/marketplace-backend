import { IsEmail, IsString, IsEnum, IsArray, IsObject, IsOptional, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class PermissionActionDto {
  view: boolean;
  edit: boolean;
  actions?: Record<string, boolean>;
  fields?: Record<string, boolean>;
  tabs?: Record<string, boolean>;
}

export class PermissionsMapDto {
  [key: string]: PermissionActionDto;
}

export class CreateAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  name: string;

  @IsEnum(['ADMIN', 'SUPPORT'])
  role: UserRole;

  @IsObject()
  permissions: PermissionsMapDto;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  supportTicketCategories?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  blurredSections?: string[];
}

export class UpdatePermissionsDto {
  @IsObject()
  @IsOptional()
  permissions?: PermissionsMapDto;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  supportTicketCategories?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  blurredSections?: string[];

  @IsEnum(['ADMIN', 'SUPPORT', 'SUPER_ADMIN'])
  @IsOptional()
  role?: UserRole;
}

export class ChangeAdminPasswordDto {
  @IsString()
  @MinLength(8)
  newPassword: string;
}
