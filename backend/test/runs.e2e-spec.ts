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

/** The prompt of every turn the fake provider ran, with its model. */
const turns: { text: string; model?: string }[] = [];

/**
 * A provider that answers every turn with "one two three", a word every
 * `delay` ms, and stops when the turn is stopped. A prompt with `ECHO<<…>>`
 * gets what is between the brackets instead, at once.
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
      turns.push({ text: ctx.prompt.text, model: ctx.model });
      yield {
        type: 'session',
        provider: 'fake',
        sessionId: ctx.sessionId ?? `s${++sessions}`,
        model: 'fake-1',
      };
      const echo = /ECHO<<([\s\S]*?)>>/.exec(ctx.prompt.text);
      for (const word of echo ? [echo[1]] : ['one ', 'two ', 'three']) {
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
          id?: string;
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
    // Saved as a list, like runs from before steps had ids.
    await prisma.run.update({
      where: { id: first },
      data: {
        status: 'interrupted',
        stepsJson: JSON.stringify([
          {
            agent: 'writer',
            output: 'one two three',
            isError: false,
            complete: true,
          },
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
    expect(
      events.flatMap((e) =>
        e.data.type === 'step_started' ? [e.data.id] : [],
      ),
    ).toEqual(['step-1', 'step-2']);
    expect(events.at(-1)?.data).toEqual({ type: 'finished', status: 'done' });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: resumed } });
    expect(run.resumeOf).toBe(first);
    const steps = JSON.parse(run.stepsJson) as Record<
      string,
      { output: string; status: string }
    >;
    expect(
      Object.entries(steps).map(([id, st]) => [id, st.output, st.status]),
    ).toEqual([
      ['step-1', 'one two three', 'done'],
      ['step-2', 'one two three', 'done'],
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

  it('runs a workflow with the agents and models chosen, then passes it on to the chat', async () => {
    const { userId } = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
    });
    await prisma.resource.create({
      data: {
        userId,
        kind: 'agent',
        key: 'critic',
        specJson: JSON.stringify({
          description: 'Criticizes',
          enabledByDefault: true,
          permissions: { files: 'read' },
          prompt: 'Criticize.',
        }),
      },
    });
    const start = (body: Record<string, unknown>) =>
      http()
        .post(`/api/projects/${projectId}/workflows/two/runs`)
        .set('Authorization', auth)
        .send({ input: 'go', ...body });

    // Only the agents the workflow names can be given to someone else.
    await start({ assign: [{ slot: 'nobody', agent: 'critic' }] }).expect(400);

    const runId = (
      await start({
        assign: [{ slot: 'writer', agent: 'critic', model: 'fake:fake-2' }],
      }).expect(202)
    ).body.runId as number;
    await until(async () => (await status(runId)) === 'done');
    const steps = (
      await http().get(`/api/runs/${runId}`).set('Authorization', auth)
    ).body.steps as { agent: string; model?: string; role?: string }[];
    expect(steps.map((st) => [st.agent, st.model, st.role])).toEqual([
      ['critic', 'fake:fake-2', 'writer'],
      ['critic', 'fake:fake-2', 'writer'],
    ]);
    expect(turns.at(-1)?.model).toBe('fake-2');

    // The next turn of the new conversation gets it, and the run joins the conversation.
    const turn = (
      await send({ message: 'what did it find?', workflowRuns: [runId] }).expect(
        202,
      )
    ).body.runId as number;
    await until(async () => (await status(turn)) === 'done');
    const prompt = turns.at(-1)!.text;
    expect(prompt.startsWith('what did it find?\n\n')).toBe(true);
    expect(prompt).toContain(`<workflow-run id="${runId}">`);
    const { sessionId } = await prisma.run.findUniqueOrThrow({
      where: { id: turn },
    });
    const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.sessionId).toBe(sessionId);

    // A run of another conversation can't be passed on.
    await send({
      message: 'again',
      sessionId: 'fake:other',
      workflowRuns: [runId],
    }).expect(400);
  });

  describe('workflow steps that need approval', () => {
    const start = async () =>
      (
        await http()
          .post(`/api/projects/${projectId}/workflows/gated/runs`)
          .set('Authorization', auth)
          .send({ input: 'go' })
          .expect(202)
      ).body.runId as number;
    const steps = async (runId: number) =>
      (await http().get(`/api/runs/${runId}`).set('Authorization', auth)).body
        .steps as {
        id: string;
        status: string;
        prompt?: string;
        note?: string;
      }[];
    const stepStatus = async (runId: number, id: string) =>
      (await steps(runId)).find((st) => st.id === id)?.status;
    const step = (runId: number, id: string, action: string) =>
      http()
        .post(`/api/runs/${runId}/steps/${id}/${action}`)
        .set('Authorization', auth);

    beforeAll(async () => {
      const { userId } = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
      });
      await prisma.resource.createMany({
        data: [
          {
            userId,
            kind: 'agent',
            key: 'gatekeeper',
            specJson: JSON.stringify({
              description: 'Reads',
              enabledByDefault: true,
              permissions: { files: 'read' },
              prompt: 'Read.',
            }),
          },
          {
            userId,
            kind: 'workflow',
            key: 'gated',
            specJson: JSON.stringify({
              description:
                'A step that needs approval next to one that does not',
              enabledByDefault: true,
              steps: [
                { id: 'free', needs: [], agent: 'gatekeeper', prompt: 'a' },
                {
                  id: 'gate',
                  needs: [],
                  approval: true,
                  agent: 'gatekeeper',
                  prompt: 'b {{input}}',
                },
                {
                  id: 'join',
                  needs: ['free', 'gate'],
                  agent: 'gatekeeper',
                  prompt: '{{steps.free}} {{steps.gate}}',
                },
              ],
            }),
          },
        ],
      });
    });

    it('takes an approval while other steps run', async () => {
      const runId = await start();
      await until(
        async () => (await stepStatus(runId, 'gate')) === 'waiting_approval',
      );
      expect(await status(runId)).toBe('running');
      await step(runId, 'gate', 'approve').expect(202);
      await until(async () => (await status(runId)) === 'done');
      expect((await steps(runId)).map((st) => [st.id, st.status])).toEqual([
        ['free', 'done'],
        ['gate', 'done'],
        ['join', 'done'],
      ]);
    });

    it('waits with nothing else to do, then goes on on the same log', async () => {
      const runId = await start();
      await until(async () => (await status(runId)) === 'waiting');
      const gate = (await steps(runId)).find((st) => st.id === 'gate');
      expect(gate).toMatchObject({
        status: 'waiting_approval',
        prompt: 'b go',
      });
      await step(runId, 'free', 'approve').expect(409);

      await step(runId, 'gate', 'approve').expect(202);
      const events = parseEvents((await follow(runId).expect(200)).text);
      expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1));
      expect(events.filter((e) => e.data.type === 'finished')).toHaveLength(1);
      expect(
        events.flatMap((e) =>
          e.data.type === 'step_started' ? [e.data.id] : [],
        ),
      ).toEqual(['free', 'gate', 'join']);
      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      expect(run.status).toBe('done');
      expect(run.costUsd).toBeCloseTo(0.03);
    });

    it('ends the run when a step is rejected', async () => {
      const runId = await start();
      await until(async () => (await status(runId)) === 'waiting');
      await step(runId, 'gate', 'reject').send({ note: 'not now' }).expect(202);
      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      expect(run.status).toBe('aborted');
      expect(run.error).toBe('Passo gate rifiutato: not now');
      const gate = (await steps(runId)).find((st) => st.id === 'gate');
      expect(gate).toMatchObject({ status: 'aborted', note: 'not now' });
    });
  });

  describe('workflow verdicts and repeats', () => {
    const start = async (key: string) =>
      (
        await http()
          .post(`/api/projects/${projectId}/workflows/${key}/runs`)
          .set('Authorization', auth)
          .send({ input: 'go' })
          .expect(202)
      ).body.runId as number;
    const ended = async (runId: number) => {
      await until(async () => ['done', 'failed'].includes(await status(runId)));
      return prisma.run.findUniqueOrThrow({ where: { id: runId } });
    };
    type Step = {
      status: string;
      output: string;
      verdict?: string;
      warning?: string;
      iterations?: { output: string; check: { output: string } }[];
    };
    const stepsOf = (run: { stepsJson: string }) =>
      JSON.parse(run.stepsJson) as Record<string, Step>;
    const rounds = (text: string) =>
      parseEvents(text).flatMap((e) =>
        e.data.type === 'iteration_started'
          ? [`${e.data.id}${(e.data as { iteration?: number }).iteration}`]
          : [],
      );
    const fix = (until: string, max: number, onMax?: string) => ({
      id: 'fix',
      needs: [],
      agent: 'looper',
      prompt: 'ECHO<<fixed {{iteration}} after [{{steps.check}}]>>',
      repeat: { with: 'check', until, max, ...(onMax ? { onMax } : {}) },
    });
    const workflow = (key: string, steps: unknown[]) => ({
      userId: 0,
      kind: 'workflow',
      key,
      specJson: JSON.stringify({
        description: key,
        enabledByDefault: true,
        steps,
      }),
    });

    beforeAll(async () => {
      const { userId } = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
      });
      const never = {
        id: 'check',
        agent: 'looper',
        verdict: ['ok', 'again'],
        prompt: 'ECHO<<still wrong\nVERDETTO: again>>',
      };
      await prisma.resource.createMany({
        data: [
          {
            userId,
            kind: 'agent',
            key: 'looper',
            specJson: JSON.stringify({
              description: 'Loops',
              enabledByDefault: true,
              permissions: { files: 'read' },
              prompt: 'Loop.',
            }),
          },
          workflow('loop', [
            fix('2', 3),
            {
              id: 'check',
              agent: 'looper',
              verdict: ['1', '2', '3'],
              prompt:
                'ECHO<<checked {{iteration}}\n**VERDETTO: {{iteration}}**>>',
            },
            {
              id: 'after',
              agent: 'looper',
              prompt: 'ECHO<<{{steps.fix}}|{{steps.check}}>>',
            },
          ]),
          workflow('stuck', [fix('ok', 2), never]),
          workflow('stuck-on', [fix('ok', 2, 'continue'), never]),
          workflow('mute', [
            { agent: 'looper', verdict: ['ok', 'no'], prompt: 'say nothing' },
          ]),
        ].map((w) => ({ ...w, userId })),
      });
    });

    it('repeats a step until its check says so', async () => {
      const runId = await start('loop');
      const run = await ended(runId);
      expect(run.status).toBe('done');
      const steps = stepsOf(run);
      expect(steps.fix.iterations).toHaveLength(2);
      expect(steps.check).toMatchObject({
        status: 'done',
        output: 'checked 2',
        verdict: '2',
      });
      expect(steps.after.output).toBe('fixed 2 after [checked 1]|checked 2');
      expect(steps.fix.iterations![0].output).toBe(
        'fixed 1 after [(nessuna verifica ancora)]',
      );
      expect(rounds((await follow(runId).expect(200)).text)).toEqual([
        'fix1',
        'check1',
        'fix2',
        'check2',
      ]);
    });

    it('resumes a repeat from its last full round', async () => {
      const done = await ended(await start('loop'));
      const [first] = stepsOf(done).fix.iterations!;
      await prisma.run.update({
        where: { id: done.id },
        data: {
          status: 'interrupted',
          stepsJson: JSON.stringify({
            fix: {
              agent: 'looper',
              status: 'running',
              output: '',
              costUsd: 0,
              startedAt: null,
              finishedAt: null,
              iterations: [first],
            },
          }),
        },
      });
      const resumed = (
        await http()
          .post(`/api/runs/${done.id}/resume`)
          .set('Authorization', auth)
          .expect(202)
      ).body.runId as number;
      const run = await ended(resumed);
      expect(run.status).toBe('done');
      expect(rounds((await follow(resumed).expect(200)).text)).toEqual([
        'fix2',
        'check2',
      ]);
      expect(stepsOf(run).fix.iterations).toHaveLength(2);
    });

    it('fails a repeat that runs out of rounds', async () => {
      const run = await ended(await start('stuck'));
      expect(run.status).toBe('failed');
      expect(run.error).toBe(
        'Passo fix: check non ha dato "ok" in 2 iterazioni',
      );
      const steps = stepsOf(run);
      expect([steps.fix.status, steps.check.status]).toEqual([
        'failed',
        'done',
      ]);
      expect(steps.fix.iterations).toHaveLength(2);
    });

    it('goes on with a warning when told to', async () => {
      const run = await ended(await start('stuck-on'));
      expect(run.status).toBe('done');
      expect(stepsOf(run).fix.warning).toBe(
        'check non ha dato "ok" in 2 iterazioni: si prosegue con l\'ultima',
      );
    });

    it('fails a step that gives no verdict, after asking again', async () => {
      const runId = await start('mute');
      const run = await ended(runId);
      expect(run.status).toBe('failed');
      expect(run.error).toBe(
        'Il passo step-1 non ha dato un verdetto valido (ok, no)',
      );
      const sessions = parseEvents(
        (await follow(runId).expect(200)).text,
      ).filter((e) => e.data.type === 'session');
      // Asked again in the same session.
      const ids = sessions.map(
        (e) => (e.data as { sessionId?: string }).sessionId,
      );
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBeTruthy();
      expect(ids[1]).toBe(ids[0]);
    });
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
