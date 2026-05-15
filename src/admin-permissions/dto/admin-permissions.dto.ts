import { IsEmail, IsString, IsArray, IsObject, IsOptional, MinLength, IsIn } from 'class-validator';
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
  name: string;

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
}

export class ChangeAdminPasswordDto {
  @IsString()
  @MinLength(8)
  newPassword: string;
}
