import { blockedBy, rateLimitedUntil, type RunLimits } from './limits.js';

const limits: RunLimits = {
  concurrent: 6,
  workflowsPerUser: 2,
  chatsPerUser: 3,
  writersPerProject: 1,
  queuedPerUser: 20,
};

const chat = (projectId = 1, userId = 1) => ({
  userId,
  projectId,
  kind: 'chat',
  writes: true,
});
const workflow = (writes: boolean, projectId = 1, userId = 1) => ({
  userId,
  projectId,
  kind: 'workflow',
  writes,
});

describe('blockedBy', () => {
  it('lets conversations of the same project run together', () => {
    expect(blockedBy(chat(), [chat(), chat()], limits)).toBeNull();
  });

  it('counts chats and workflows apart for the user', () => {
    expect(
      blockedBy(chat(), [workflow(false), workflow(false)], limits),
    ).toBeNull();
    expect(
      blockedBy(
        workflow(false, 2),
        [workflow(false), workflow(false, 3)],
        limits,
      ),
    ).toEqual({
      code: 'user',
    });
    expect(blockedBy(chat(), [chat(2), chat(3), chat(4)], limits)).toEqual({
      code: 'user',
    });
  });

  it('keeps one writing workflow per project', () => {
    expect(blockedBy(workflow(true), [workflow(true)], limits)).toEqual({
      code: 'project',
    });
    expect(blockedBy(workflow(true), [workflow(true, 2)], limits)).toBeNull();
    expect(blockedBy(workflow(false), [workflow(true)], limits)).toBeNull();
    // A chat that may write doesn't hold back a workflow, nor the other way round.
    expect(blockedBy(workflow(true), [chat()], limits)).toBeNull();
  });

  it('caps the whole instance', () => {
    const others = [1, 2, 3, 4, 5, 6].map((u) => chat(u, u + 10));
    expect(blockedBy(chat(), others, limits)).toEqual({ code: 'instance' });
  });

  it('gives mission runs no per-user limit of their own', () => {
    const orchestrator = { userId: 1, projectId: 1, kind: 'mission-orchestrator', writes: false };
    const task = { userId: 1, projectId: 1, kind: 'mission-task', writes: false };
    expect(
      blockedBy(orchestrator, [orchestrator, orchestrator, orchestrator], limits),
    ).toBeNull();
    expect(
      blockedBy(task, [task, task, task, task], limits),
    ).toBeNull();
    // They still count for the instance limit.
    const others = [1, 2, 3, 4, 5, 6].map((u) => chat(u, u + 10));
    expect(blockedBy(orchestrator, others, limits)).toEqual({ code: 'instance' });
  });

  it('keeps mission tasks out of the project writers', () => {
    const task = { userId: 1, projectId: 1, kind: 'mission-task', writes: true };
    expect(blockedBy(workflow(true), [task], limits)).toBeNull();
    expect(blockedBy(task, [workflow(true)], limits)).toBeNull();
  });
});

describe('rateLimitedUntil', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  const snapshot = (status: string, resetsAt: string) => ({
    status,
    windows: { five_hour: { status, resetsAt, utilization: 1 } },
  });

  it('holds runs until the latest rejected window resets', () => {
    expect(
      rateLimitedUntil(snapshot('rejected', '2026-10-28T15:00:00Z'), now),
    ).toBe('2026-10-28T15:00:00Z');
  });

  it('lets them go once allowed or past the reset', () => {
    expect(
      rateLimitedUntil(snapshot('allowed', '2026-10-28T15:00:00Z'), now),
    ).toBeNull();
    expect(
      rateLimitedUntil(snapshot('rejected', '2026-10-28T11:00:00Z'), now),
    ).toBeNull();
    expect(rateLimitedUntil(undefined, now)).toBeNull();
  });
});
