import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, AppConfig } from './config';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Global guard: `Authorization: Bearer <shared token>` (ADR-0002). */
@Injectable()
export class BearerGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const header: string | undefined = context.switchToHttp().getRequest().headers.authorization;
    const match = header?.match(/^Bearer (.+)$/);
    if (!match || !timingSafeEqual(digest(match[1]), digest(this.config.token))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
