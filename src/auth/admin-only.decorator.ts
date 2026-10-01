import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiForbiddenResponse } from '@nestjs/swagger';

export const ADMIN_ONLY = 'ai-scanner:admin-only';

/** Routes that only the admin token opens: they change what every Scan can do (ADR-0006). */
export const AdminOnly = () =>
  applyDecorators(SetMetadata(ADMIN_ONLY, true), ApiForbiddenResponse({ description: 'Not the admin token, or no admin token is configured' }));
