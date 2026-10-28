import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type {
  AgentProvider,
  ChatEvent,
  RunContext,
} from '../src/providers/provider.js';

/**
 * A provider that answers every turn with "one two three", a word every
 * `delay` ms, and stops when the turn is stopped.
 */
function fakeProvider(delay = 60): AgentProvider {
  let sessions = 0;
  return {
    id: 'fake',
    label: 'Fake',
    supports: { tools: false, mcp: false, skills: false, agents: false },
    status: () =>
      Promise.resolve({
        methods: ['local'],
        connected: true,
        method: 'local',
        secretHint: null,
        connectedAt: null,
        version: null,
        models: [],
      }),
    disconnect: () => Promise.resolve(),
    async *run(ctx: RunContext): AsyncGenerator<ChatEvent> {
      yield {
        type: 'session',
        provider: 'fake',
        sessionId: ctx.sessionId ?? `s${++sessions}`,
        model: 'fake-1',
      };
      for (const word of ['one ', 'two ', 'three']) {
        await new Promise((r) => setTimeout(r, delay));
        if (ctx.signal.aborted) return;
        yield { type: 'text', text: word };
      }
      yield {
        type: 'done',
        isError: false,
        costUsd: 0.01,
        durationMs: 1,
        turns: 1,
      };
    },
    sessions: () => Promise.resolve([]),
    history: () => Promise.resolve([]),
  } as AgentProvider;
}

/** Reads an SSE response to its end: the events' ids and payloads. */
function parseEvents(body: string) {
  return body
    .split('\n\n')
    .filter((frame) => frame.includes('data: '))
    .map((frame) => {
      const id = /^id: (\d+)$/m.exec(frame)?.[1];
      const data = /^data: (.*)$/m.exec(frame)![1];
      return {
        id: Number(id),
        data: JSON.parse(data) as {
          type: string;
          text?: string;
          status?: string;
        },
      };
    });
}

describe('Background runs (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let dir: string;
  let auth: string;
  let projectId: number;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'runs-e2e-')));
    const url = `file:${join(dir, 'test.db')}`;
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    });
    Object.assign(process.env, {
      DATABASE_URL: url,
      WORKSPACE_ROOT: dir,
      DATA_DIR: join(dir, 'data'),
      RUNS_MAX_CHATS_PER_USER: '1',
    });

    // Imported after the environment is set: the config reads it once.
    const { AppModule } = await import('../src/app.module.js');
    const { AGENT_PROVIDERS } =
      await import('../src/providers/providers.service.js');
    const { PrismaService } = await import('../src/prisma/prisma.service.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_PROVIDERS)
      .useValue([fakeProvider()])
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    // As in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
    const user = await prisma.user.create({
      data: { email: 'runs@example.com', passwordHash: 'x' },
    });
    await prisma.providerConnection.create({
      data: { userId: user.id, provider: 'fake', method: 'local' },
    });
    const folder = join(dir, 'project');
    await mkdir(folder);
    const project = await prisma.project.create({
      data: { userId: user.id, name: 'P', path: folder },
    });
    projectId = project.id;
    auth = `Bearer ${app.get(JwtService).sign({ sub: user.id, email: user.email })}`;
  });

  afterAll(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const http = () => request(app.getHttpServer());
  const send = (body: Record<string, unknown>) =>
    http()
      .post('/api/chat/messages')
      .set('Authorization', auth)
      .send({ projectId, ...body });
  const follow = (runId: number, after = 0) =>
    http()
      .get(`/api/runs/${runId}/events?after=${after}`)
      .set('Authorization', auth)
      .buffer(true);
  const status = async (runId: number) =>
    (await http().get(`/api/runs/${runId}`).set('Authorization', auth)).body
      .status as string;

  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('Timed out');
  }

  it('runs a turn in the background and replays it in full', async () => {
    const created = await send({ message: 'hi' }).expect(202);
    const { runId } = created.body as { runId: number };

    // Nobody follows it: it still ends.
    await until(async () => (await status(runId)) === 'done');

    const events = parseEvents((await follow(runId).expect(200)).text);
    const text = events
      .filter((e) => e.data.type === 'text')
      .map((e) => e.data.text)
      .join('');
    expect(text).toBe('one two three');
    expect(events.at(-1)?.data).toEqual({ type: 'finished', status: 'done' });
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1));

    // From a cursor: exactly the events after it.
    const rest = parseEvents((await follow(runId, 2).expect(200)).text);
    expect(rest.map((e) => e.id)).toEqual(events.slice(2).map((e) => e.id));

    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.sessionId).toBe('fake:s1');
    expect(run.costUsd).toBeCloseTo(0.01);
  });

  it('streams a turn live while it runs', async () => {
    const { runId } = (await send({ message: 'live' }).expect(202)).body as {
      runId: number;
    };
    const events = parseEvents((await follow(runId).expect(200)).text);
    expect(
      events
        .filter((e) => e.data.type === 'text')
        .map((e) => e.data.text)
        .join(''),
    ).toBe('one two three');
    expect(events.at(-1)?.data).toEqual({ type: 'finished', status: 'done' });
  });

  it('keeps running after the client stops following', async () => {
    const { runId } = (await send({ message: 'leave' }).expect(202)).body as {
      runId: number;
    };
    const req = follow(runId);
    setTimeout(() => req.abort(), 80);
    await req.catch(() => undefined);
    await until(async () => (await status(runId)) === 'done');
  });

  it('resumes a workflow from the first step not done', async () => {
    const { userId } = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    await prisma.resource.createMany({
      data: [
        {
          userId,
          kind: 'agent',
          key: 'writer',
          specJson: JSON.stringify({
            description: 'Writes',
            enabledByDefault: true,
            permissions: { files: 'read' },
            prompt: 'Write.',
          }),
        },
        {
          userId,
          kind: 'workflow',
          key: 'two',
          specJson: JSON.stringify({
            description: 'Two steps',
            enabledByDefault: true,
            steps: [
              { agent: 'writer', prompt: '{{input}}' },
              { agent: 'writer', prompt: '{{previous}}' },
            ],
          }),
        },
      ],
    });
    const first = (
      await http()
        .post(`/api/projects/${projectId}/workflows/two/runs`)
        .set('Authorization', auth)
        .send({ input: 'go' })
        .expect(202)
    ).body.runId as number;
    await until(async () => (await status(first)) === 'done');

    // As if the backend died during the second step.
    const done = await prisma.run.findUniqueOrThrow({ where: { id: first } });
    const [kept] = JSON.parse(done.stepsJson) as unknown[];
    await prisma.run.update({
      where: { id: first },
      data: {
        status: 'interrupted',
        stepsJson: JSON.stringify([
          kept,
          { agent: 'writer', output: 'on', isError: false, complete: false },
        ]),
      },
    });

    const resumed = (
      await http()
        .post(`/api/runs/${first}/resume`)
        .set('Authorization', auth)
        .expect(202)
    ).body.runId as number;
    const events = parseEvents((await follow(resumed).expect(200)).text);
    expect(events.filter((e) => e.data.type === 'step').length).toBe(2);
    expect(events.at(-1)?.data).toEqual({ type: 'finished', status: 'done' });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: resumed } });
    expect(run.resumeOf).toBe(first);
    const steps = JSON.parse(run.stepsJson) as {
      output: string;
      complete: boolean;
    }[];
    expect(steps.map((st) => [st.output, st.complete])).toEqual([
      ['one two three', true],
      ['one two three', true],
    ]);

    // A changed workflow can't be resumed.
    await prisma.run.update({
      where: { id: first },
      data: { workflowHash: 'old' },
    });
    await http()
      .post(`/api/runs/${first}/resume`)
      .set('Authorization', auth)
      .expect(409);
  });

  it('takes one turn at a time per conversation', async () => {
    const first = await send({ message: 'again', sessionId: 'fake:s1' }).expect(
      202,
    );
    await send({ message: 'too soon', sessionId: 'fake:s1' }).expect(409);
    await until(
      async () => (await status(first.body.runId as number)) === 'done',
    );
  });

  it('queues turns past the limit and stops them on request', async () => {
    const running = (await send({ message: 'a' }).expect(202)).body
      .runId as number;
    const queued = (await send({ message: 'b' }).expect(202)).body
      .runId as number;
    await until(async () => (await status(running)) === 'running');

    const view = (
      await http().get(`/api/runs/${queued}`).set('Authorization', auth)
    ).body;
    expect(view.status).toBe('queued');
    expect(view.reason).toEqual({ code: 'user' });

    await http()
      .post(`/api/runs/${queued}/abort`)
      .set('Authorization', auth)
      .expect(202);
    expect(await status(queued)).toBe('aborted');
    await http()
      .post(`/api/runs/${running}/abort`)
      .set('Authorization', auth)
      .expect(202);
    await until(async () => (await status(running)) === 'aborted');

    const events = parseEvents((await follow(queued).expect(200)).text);
    expect(events.at(-1)?.data).toEqual({
      type: 'finished',
      status: 'aborted',
    });
  });

  it("hides another user's runs", async () => {
    const other = await prisma.user.create({
      data: { email: 'other@example.com', passwordHash: 'x' },
    });
    const token = `Bearer ${app.get(JwtService).sign({ sub: other.id, email: other.email })}`;
    const runId = (await send({ message: 'mine' }).expect(202)).body
      .runId as number;
    await http()
      .get(`/api/runs/${runId}`)
      .set('Authorization', token)
      .expect(404);
    await http()
      .post(`/api/runs/${runId}/abort`)
      .set('Authorization', token)
      .expect(404);
    await http()
      .get(`/api/runs/${runId}/events`)
      .set('Authorization', token)
      .expect(404);
    await until(async () => (await status(runId)) === 'done');
  });

  it('lists active and recent runs, and marks them seen', async () => {
    const list = (
      await http()
        .get('/api/runs/active')
        .set('Authorization', auth)
        .expect(200)
    ).body as { id: number; unread: boolean; projectName: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].projectName).toBe('P');
    const unread = list.find((r) => r.unread)!;
    await http()
      .post(`/api/runs/${unread.id}/seen`)
      .set('Authorization', auth)
      .expect(204);
    const view = (
      await http().get(`/api/runs/${unread.id}`).set('Authorization', auth)
    ).body;
    expect(view.unread).toBe(false);
  });
});
