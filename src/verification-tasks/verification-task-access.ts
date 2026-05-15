import { ForbiddenException } from '@nestjs/common';

/** Roles that may access any verification task (read/write per controller), including support staff. */
const STAFF_ROLES = new Set(['SUPER_ADMIN', 'ADMIN', 'SUPPORT']);

export function assertVerificationTaskAccess(
  task: { officerId: string | null },
  userId: string,
  role: string,
  opts?: { allowUnassignedOfficer?: boolean },
): void {
  if (STAFF_ROLES.has(role)) return;

  if (role !== 'VERIFICATION_OFFICER') {
    throw new ForbiddenException('Invalid role for verification task access');
  }

  if (!task.officerId) {
    if (opts?.allowUnassignedOfficer) return;
    throw new ForbiddenException('This task is not assigned to you');
  }

  if (task.officerId !== userId) {
    throw new ForbiddenException('You can only access tasks assigned to you');
  }
}

export function isAdminRole(role: string): boolean {
  return role === 'SUPER_ADMIN' || role === 'ADMIN';
}
