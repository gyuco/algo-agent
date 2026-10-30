import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

/**
 * The compiled frontend (`frontend/dist`), served from this process so the app is one
 * origin in production: `/api` needs no CORS, and one port is enough to expose it
 * (e.g. through `tailscale serve`). Absent in dev, where Vite serves the app on 5173.
 */
function frontendDist(): string {
  const dist = dirname(fileURLToPath(import.meta.url)); // backend/dist
  return process.env.FRONTEND_DIST ?? join(dist, '..', '..', 'frontend', 'dist');
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Lets running runs finish, or be marked interrupted, before the process exits.
  app.enableShutdownHooks();
  // Chat attachments travel as base64 in the JSON body (up to 5 files of 5 MB).
  app.useBodyParser('json', { limit: '40mb' });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Personal mode stores the owner's Claude subscription token: never expose it beyond this machine.
  const port = process.env.PORT ?? 3000;
  if (process.env.PERSONAL_MODE === 'true') await app.listen(port, '127.0.0.1');
  else await app.listen(port);
}
await bootstrap();
