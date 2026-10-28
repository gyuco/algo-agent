import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { CatalogService } from '../src/catalog/catalog.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

describe('Project secrets and resources (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let catalog: CatalogService;
  let dir: string;
  let userId: number;
  let auth: string;
  let otherAuth: string;
  let projectId: number;
  let otherProjectId: number;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'vault-e2e-')));
    const url = `file:${join(dir, 'test.db')}`;
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    });
    Object.assign(process.env, {
      DATABASE_URL: url,
      WORKSPACE_ROOT: dir,
      DATA_DIR: join(dir, 'data'),
      PERSONAL_MODE: 'false',
      VAULT_TEST_HOST_VAR: 'host-only',
    });

    // Imported after the environment is set: the config reads it once.
    const { AppModule } = await import('../src/app.module.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const { CatalogService } =
      await import('../src/catalog/catalog.service.js');
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

    prisma = app.get(PrismaService);
    catalog = app.get(CatalogService);
    const jwt = app.get(JwtService);
    const user = await prisma.user.create({
      data: { email: 'vault@example.com', passwordHash: 'x' },
    });
    const other = await prisma.user.create({
      data: { email: 'other@example.com', passwordHash: 'x' },
    });
    userId = user.id;
    auth = `Bearer ${jwt.sign({ sub: user.id, email: user.email })}`;
    otherAuth = `Bearer ${jwt.sign({ sub: other.id, email: other.email })}`;
    const folder = join(dir, 'project');
    await mkdir(folder);
    projectId = (
      await prisma.project.create({
        data: { userId: user.id, name: 'P', path: folder },
      })
    ).id;
    await mkdir(join(dir, 'other'));
    otherProjectId = (
      await prisma.project.create({
        data: { userId: user.id, name: 'Q', path: join(dir, 'other') },
      })
    ).id;
  });

  afterAll(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());

  it('keeps values write-only and lets the project override the user', async () => {
    await http()
      .put('/api/secrets/GH_TOKEN')
      .set('Authorization', auth)
      .send({ value: 'ghp_user_000000000001' })
      .expect(204);
    await http()
      .put('/api/secrets/GH_TOKEN')
      .set('Authorization', auth)
      .send({ value: 'ghp_user_000000000002' })
      .expect(204);
    await http()
      .put('/api/secrets/SHARED')
      .set('Authorization', auth)
      .send({ value: 'shared' })
      .expect(204);
    await http()
      .put(`/api/projects/${projectId}/secrets/GH_TOKEN`)
      .set('Authorization', auth)
      .send({ value: 'ghp_project_00000099' })
      .expect(204);

    const mine = await http()
      .get('/api/secrets')
      .set('Authorization', auth)
      .expect(200);
    expect(JSON.stringify(mine.body)).not.toContain('ghp_');
    expect(mine.body).toMatchObject([
      { name: 'GH_TOKEN', hint: '…0002' },
      { name: 'SHARED', hint: '…' },
    ]);
    // Replacing didn't duplicate the user's secret (its project id is NULL).
    expect(await prisma.secret.count({ where: { projectId: null } })).toBe(2);

    const { variables } = await catalog.forProject(userId, projectId);
    expect(variables).toEqual({
      GH_TOKEN: 'ghp_project_00000099',
      SHARED: 'shared',
    });
  });

  it("doesn't hand the backend's environment to a user who isn't the owner", async () => {
    const { variables } = await catalog.forProject(userId, projectId);
    expect(variables).not.toHaveProperty('VAULT_TEST_HOST_VAR');
    expect(variables).not.toHaveProperty('ENCRYPTION_KEY');
  });

  it('refuses bad names and other users', async () => {
    await http()
      .put('/api/secrets/1BAD')
      .set('Authorization', auth)
      .send({ value: 'x' })
      .expect(400);
    await http()
      .put(`/api/projects/${projectId}/secrets/GH_TOKEN`)
      .set('Authorization', otherAuth)
      .send({ value: 'x' })
      .expect(404);
    await http()
      .delete('/api/secrets/SHARED')
      .set('Authorization', otherAuth)
      .expect(404);
  });

  it('does not decrypt a value moved to another row', async () => {
    const [user, project] = await Promise.all([
      prisma.secret.findFirstOrThrow({
        where: { projectId: null, name: 'GH_TOKEN' },
      }),
      prisma.secret.findFirstOrThrow({ where: { projectId } }),
    ]);
    await prisma.secret.update({
      where: { id: project.id },
      data: { valueEncrypted: user.valueEncrypted },
    });
    await expect(catalog.forProject(userId, projectId)).rejects.toThrow();
  });

  const ghServer = {
    description: 'GitHub',
    type: 'http',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: 'Bearer ${GH_TOKEN}' },
  };

  it('keeps a project resource in its project, switched on', async () => {
    await http()
      .post(`/api/projects/${projectId}/library/mcp/gh`)
      .set('Authorization', auth)
      .send(ghServer)
      .expect(204);

    const here = await http()
      .get(`/api/projects/${projectId}/resources`)
      .set('Authorization', auth)
      .expect(200);
    expect(here.body.mcp).toEqual([
      {
        key: 'gh',
        description: 'GitHub',
        type: 'http',
        enabled: true,
        own: true,
        needs: ['GH_TOKEN'],
      },
    ]);

    const elsewhere = await http()
      .get(`/api/projects/${otherProjectId}/resources`)
      .set('Authorization', auth)
      .expect(200);
    expect(elsewhere.body.mcp).toEqual([]);
    const library = await http()
      .get('/api/resources')
      .set('Authorization', auth)
      .expect(200);
    expect(library.body.mcp).toEqual([]);

    // A key is the user's everywhere: not again in the library or another project.
    await http()
      .post('/api/resources/mcp/gh')
      .set('Authorization', auth)
      .send(ghServer)
      .expect(409);
    await http()
      .post(`/api/projects/${otherProjectId}/library/mcp/gh`)
      .set('Authorization', auth)
      .send(ghServer)
      .expect(409);
    // Nor edited through another project.
    await http()
      .put(`/api/projects/${otherProjectId}/library/mcp/gh`)
      .set('Authorization', auth)
      .send(ghServer)
      .expect(404);
    await http()
      .post(`/api/projects/${projectId}/library/mcp/x`)
      .set('Authorization', otherAuth)
      .send(ghServer)
      .expect(404);
  });

  it("won't delete a library resource a project's agent uses", async () => {
    await http()
      .post('/api/resources/skill/style')
      .set('Authorization', auth)
      .send({ description: 'Style', content: 'Write tersely.' })
      .expect(204);
    await http()
      .post(`/api/projects/${projectId}/library/agent/writer`)
      .set('Authorization', auth)
      .send({
        description: 'Writer',
        prompt: 'Write.',
        permissions: { skills: ['style'], mcp: ['gh'] },
      })
      .expect(204);

    await http()
      .delete('/api/resources/skill/style')
      .set('Authorization', auth)
      .expect(409);
    await http()
      .delete(`/api/projects/${projectId}/library/mcp/gh`)
      .set('Authorization', auth)
      .expect(409);

    await http()
      .delete(`/api/projects/${projectId}/library/agent/writer`)
      .set('Authorization', auth)
      .expect(204);
    await http()
      .delete('/api/resources/skill/style')
      .set('Authorization', auth)
      .expect(204);
  });
});
