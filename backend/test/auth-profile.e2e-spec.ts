import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { App } from 'supertest/types.js';

describe('Account profile (e2e)', () => {
  let app: INestApplication<App>;
  let dir: string;
  let token: string;

  const password = 'old-password-1';

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'profile-e2e-')));
    const url = `file:${join(dir, 'test.db')}`;
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    });
    Object.assign(process.env, {
      DATABASE_URL: url,
      PERSONAL_MODE: 'false',
    });

    // Imported after the environment is set: the config reads it once.
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
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

    const prisma = app.get(PrismaService);
    await prisma.user.create({
      data: {
        email: 'profile@example.com',
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
    await prisma.user.create({
      data: { email: 'taken@example.com', passwordHash: 'x' },
    });

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'profile@example.com', password })
      .expect(200);
    token = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('updates the name and email and reissues a working token', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Giuseppe', email: 'GiusEPPe+new@example.com' })
      .expect(200);

    expect(res.body.user).toMatchObject({
      name: 'Giuseppe',
      email: 'giuseppe+new@example.com',
    });
    expect(res.body.accessToken).toEqual(expect.any(String));

    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200)
      .expect((me) => {
        expect(me.body).toMatchObject({
          name: 'Giuseppe',
          email: 'giuseppe+new@example.com',
        });
      });
  });

  it('rejects an email already used by another account', async () => {
    await request(app.getHttpServer())
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'taken@example.com' })
      .expect(409);
  });

  it('clears the display name when sent empty', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '' })
      .expect(200);

    expect(res.body.user.name).toBeNull();
  });

  it('refuses a wrong current password', async () => {
    await request(app.getHttpServer())
      .patch('/api/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'not-it-at-all', newPassword: 'new-password-1' })
      .expect(401);
  });

  it('refuses reusing the current password', async () => {
    await request(app.getHttpServer())
      .patch('/api/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: password, newPassword: password })
      .expect(400);
  });

  it('changes the password and the new one signs in', async () => {
    await request(app.getHttpServer())
      .patch('/api/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: password, newPassword: 'new-password-1' })
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'giuseppe+new@example.com', password })
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'giuseppe+new@example.com', password: 'new-password-1' })
      .expect(200);
  });
});
