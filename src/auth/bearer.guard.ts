import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ADMIN_ONLY } from './admin-only.decorator';

const digest = (s: string) => createHash('sha256').update(s).digest();
const matches = (given: string, expected: string | undefined) =>
  expected !== undefined && timingSafeEqual(digest(given), digest(expected));

export type Role = 'admin' | 'caller';

/** What the guard sets on the request, for handlers that need the caller's role. */
export interface AuthenticatedRequest {
  role: Role;
}

/**
 * Global guard: `Authorization: Bearer <token>` (ADR-0002, ADR-0006). The shared token opens the
 * Scan API; the admin token opens that too, and also the routes marked `@AdminOnly()`.
 */
@Injectable()
export class BearerGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers.authorization;
    const token = header?.match(/^Bearer (.+)$/)?.[1];
    // Both comparisons always run, so timing tells nothing about which token was close.
    const admin = token !== undefined && matches(token, this.config.adminToken);
    const caller = token !== undefined && matches(token, this.config.token);
    if (!admin && !caller) throw new UnauthorizedException();

    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [context.getHandler(), context.getClass()]);
    if (adminOnly && !admin) {
      throw new ForbiddenException(
        this.config.adminToken ? 'This needs the admin token' : 'Administration is disabled: SCANNER_ADMIN_TOKEN is not set',
      );
    }
    request.role = admin ? 'admin' : 'caller';
    return true;
  }
}
