import { IsEmail, IsString, IsArray, IsObject, IsOptional, MinLength, IsIn, IsNotEmpty, Matches } from 'class-validator';
import { UserRole } from '@prisma/client';

/** Roles assignable from Access Control UI (not CUSTOMER/VENDOR). */
const ASSIGNABLE_ADMIN_ROLES = [
  UserRole.ADMIN,
  UserRole.SUPPORT,
  UserRole.VERIFICATION_OFFICER,
] as const;

const UPDATABLE_ADMIN_ROLES = [
  UserRole.ADMIN,
  UserRole.SUPPORT,
  UserRole.SUPER_ADMIN,
  UserRole.VERIFICATION_OFFICER,
] as const;

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
  @IsNotEmpty()
  name: string;

  /** Local digits without country code (e.g. 512345678) */
  @IsString()
  @Matches(/^\d{8,12}$/, { message: 'Phone must be 8–12 digits' })
  phone: string;

  @IsString()
  @Matches(/^\+\d{1,4}$/, { message: 'Country code must be like +966' })
  countryCode: string;

  @IsString()
  @IsNotEmpty()
  country: string;

  @IsIn(ASSIGNABLE_ADMIN_ROLES)
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

  @IsIn(UPDATABLE_ADMIN_ROLES)
  @IsOptional()
  role?: UserRole;

  @IsString()
  @Matches(/^\d{8,12}$/)
  @IsOptional()
  phone?: string;

  @IsString()
  @Matches(/^\+\d{1,4}$/)
  @IsOptional()
  countryCode?: string;

  @IsString()
  @IsOptional()
  country?: string;
}

export class ChangeAdminPasswordDto {
  @IsString()
  @MinLength(8)
  newPassword: string;
}
