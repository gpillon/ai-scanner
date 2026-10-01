import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BearerGuard } from './bearer.guard';
import { MeController } from './me.controller';

/** Every route needs a token (ADR-0002); some need the admin one (ADR-0006). The UI and API docs are not routes. */
@Module({
  controllers: [MeController],
  providers: [{ provide: APP_GUARD, useClass: BearerGuard }],
})
export class AuthModule {}
