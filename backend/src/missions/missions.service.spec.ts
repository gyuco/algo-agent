import { ConflictException } from '@nestjs/common';
import { MissionsService } from './missions.service.js';

const mission = {
  id: 7,
  userId: 1,
  projectId: 2,
  title: 'Login',
  status: 'briefing',
  orchestratorModel: 'claude:sonnet',
  sessionId: 'claude:s1',
};

function service(updated = 1) {
  let release!: () => void;
  const enqueued = new Promise<void>((resolve) => (release = resolve));
  const prisma = {
    mission: {
      findFirst: vi.fn(async () => mission),
      updateMany: vi.fn(async () => ({ count: updated })),
    },
    run: { findFirst: vi.fn(async () => null) },
    missionEntry: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 1, ...data })),
    },
  };
  const queue = {
    enqueue: vi.fn(async () => {
      await enqueued;
      return { id: 99 };
    }),
  };
  const deps = {
    prisma,
    projects: { get: async () => ({ id: 2, path: '/p' }) },
    providers: { connected: async () => [{ id: 'claude' }] },
    runner: { check: async () => ({ provider: 'claude' }) },
    queue,
    bus: { publish: vi.fn() },
  };
  const missions = new MissionsService(
    deps.prisma as never,
    {} as never,
    deps.projects as never,
    {} as never,
    {} as never,
    {} as never,
    deps.providers as never,
    deps.runner as never,
    deps.queue as never,
    { saveAttachments: async () => undefined } as never,
    {} as never,
    deps.bus as never,
  );
  return { missions, prisma, queue, release };
}

describe('MissionsService.messages', () => {
  it('queues one turn at a time, even with two requests together', async () => {
    const { missions, queue, release } = service();
    const first = missions.messages(1, 7, { text: 'sì' });
    const second = missions.messages(1, 7, { text: 'sì' });
    await expect(second).rejects.toBeInstanceOf(ConflictException);
    release();
    await expect(first).resolves.toEqual({ runId: 99 });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('refuses when the mission changed meanwhile, without queueing', async () => {
    const { missions, queue } = service(0);
    await expect(missions.messages(1, 7, { text: 'sì' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
