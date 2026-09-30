import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig } from './config/app-config';

/** Pipes, OpenAPI and the web UI, shared by `main.ts` and the tests. */
export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('ai-scanner')
      .setDescription('Submit a Source Archive, poll the Scan, download its Report.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  // Served outside the bearer guard so clients can generate code from it.
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
  serveUi(app as NestExpressApplication, app.get<AppConfig>(APP_CONFIG).uiDir);
}

/**
 * The built web UI (`ui/`), as static files under /ui/. Like the OpenAPI document it is outside
 * the bearer guard: it holds no data, and asks for the token to call the API. Without a build
 * (the backend alone, in development) there is nothing to serve.
 */
function serveUi(app: NestExpressApplication, uiDir: string | undefined): void {
  if (!uiDir || !existsSync(join(uiDir, 'index.html'))) return;
  app.useStaticAssets(uiDir, {
    prefix: '/ui/',
    // Vite names assets by content hash, so they never change; index.html names the current
    // ones, so browsers must check it on every load or they keep a page whose assets are gone.
    setHeaders: (res, path) =>
      res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  });
  const http = app.getHttpAdapter();
  http.get('/', (_req, res) => http.redirect(res, 302, '/ui/'));
}
