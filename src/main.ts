import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { mkdirSync } from 'node:fs';
import { AppModule, configureApp } from './app.module';
import { loadConfig } from './config';

async function bootstrap() {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  const app = await NestFactory.create(AppModule.register(config));
  app.enableShutdownHooks();
  configureApp(app);
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
