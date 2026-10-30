import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Covers what the app controls: the redirect, the state, the closed registration
 * and the one-time code. Google's own endpoints are stubbed.
 */
describe('Google sign-in (e2e)', () => {
  let app: INestApplication<App>;
  let dir: string;
  let google: import('../src/auth/google-oauth.service.js').GoogleOAuthService;
  let prisma: import('../src/prisma/prisma.service.js').PrismaService;

  const clientId = 'client-id.apps.googleusercontent.com';
  const secret = 'client-secret';
  const origin = 'http://localhost:5173';

  /** Answers the token and userinfo calls of the flow, without touching Google. */
  function stubGoogle(profile: Record<string, unknown>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url === 'https://oauth2.googleapis.com/token') {
          return new Response(JSON.stringify({ access_token: 'token' }), {
            status: 200,
          });
        }
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
          return new Response(JSON.stringify(profile), { status: 200 });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
  }

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'google-e2e-')));
    const db = `file:${join(dir, 'test.db')}`;
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: db },
      stdio: 'ignore',
    });
    Object.assign(process.env, {
      DATABASE_URL: db,
      PERSONAL_MODE: 'false',
      CORS_ORIGIN: origin,
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: secret,
    });

    // Imported after the environment is set: the config reads it once.
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { GoogleOAuthService } = await import(
      '../src/auth/google-oauth.service.js'
    );
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    google = app.get(GoogleOAuthService);
    prisma = app.get(PrismaService);

    await prisma.user.create({
      data: { email: 'owner@example.com', passwordHash: 'x' },
    });
    await prisma.user.create({
      data: { email: 'other@example.com', passwordHash: 'x' },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('offers the button and redirects to Google with the registered URI', async () => {
    const status = await request(app.getHttpServer())
      .get('/api/auth/google/status')
      .expect(200);
    expect(status.body).toEqual({ enabled: true });

    const res = await request(app.getHttpServer())
      .get('/api/auth/google')
      .expect(302);
    const location = new URL(res.headers.location);
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('client_id')).toBe(clientId);
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${origin}/api/auth/google/callback`,
    );
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('sends the browser back with a reason when the state is missing', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/google/callback?code=abc')
      .expect(302);
    expect(res.headers.location).toBe(
      `${origin}/?google=error&reason=state`,
    );
  });

  it('sends the browser back with a reason when Google says no', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/google/callback?error=access_denied')
      .expect(302);
    expect(res.headers.location).toBe(
      `${origin}/?google=error&reason=denied`,
    );
  });

  it('links the Google identity to the existing account', async () => {
    stubGoogle({
      sub: 'google-sub-1',
      email: 'owner@example.com',
      email_verified: true,
    });
    const state = new URL(await google.authorizationUrl()).searchParams.get(
      'state',
    )!;

    const user = await google.complete('code', state);
    expect(user.email).toBe('owner@example.com');
    const stored = await prisma.user.findUnique({
      where: { email: 'owner@example.com' },
    });
    expect(stored?.googleId).toBe('google-sub-1');
  });

  it('refuses an email that has no account, keeping registration closed', async () => {
    stubGoogle({
      sub: 'google-sub-9',
      email: 'stranger@example.com',
      email_verified: true,
    });
    const state = new URL(await google.authorizationUrl()).searchParams.get(
      'state',
    )!;

    await expect(google.complete('code', state)).rejects.toMatchObject({
      reason: 'not_registered',
    });
  });

  it('refuses a second Google identity on the same account', async () => {
    await prisma.user.update({
      where: { email: 'owner@example.com' },
      data: { googleId: 'google-sub-1' },
    });
    stubGoogle({
      sub: 'google-sub-2',
      email: 'owner@example.com',
      email_verified: true,
    });
    const state = new URL(await google.authorizationUrl()).searchParams.get(
      'state',
    )!;

    await expect(google.complete('code', state)).rejects.toMatchObject({
      reason: 'conflict',
    });
  });

  it('redeems a one-time code once and signs the user in', async () => {
    const owner = await prisma.user.findUnique({
      where: { email: 'owner@example.com' },
    });
    const code = google.issueCode(owner!.id);

    const res = await request(app.getHttpServer())
      .post('/api/auth/google/exchange')
      .send({ code })
      .expect(200);
    expect(res.body.user.email).toBe('owner@example.com');

    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200)
      .expect((me) => expect(me.body.email).toBe('owner@example.com'));

    await request(app.getHttpServer())
      .post('/api/auth/google/exchange')
      .send({ code })
      .expect(401);
  });

  it('rejects a code it never issued', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/google/exchange')
      .send({ code: 'not-a-real-code-at-all' })
      .expect(401);
  });
});
