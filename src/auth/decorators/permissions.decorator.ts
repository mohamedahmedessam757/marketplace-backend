import { SetMetadata } from '@nestjs/common';

export interface PermissionRequirement {
  page: string;
  action: 'view' | 'edit' | string;
}

export const PERMISSIONS_KEY = 'permissions';
export const Permissions = (page: string, action: 'view' | 'edit' | string = 'view') => 
  SetMetadata(PERMISSIONS_KEY, { page, action } as PermissionRequirement);
