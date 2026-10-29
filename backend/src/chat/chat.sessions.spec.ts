import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatService } from './chat.service.js';

describe('ChatService.sessions', () => {
  it('leaves the mission orchestrator sessions out and links the chat a mission came from', async () => {
    const root = await mkdtemp(join(tmpdir(), 'algo-chat-'));
    const project = { id: 1, name: 'P', path: await mkdtemp(join(root, 'p-')) };
    const provider = {
      id: 'claude',
      sessions: async () => [
        { id: 'chat-1', title: 'Chat', updatedAt: '2026-10-29T10:00:00.000Z' },
        { id: 'mission-1', title: 'Mission', updatedAt: '2026-10-29T11:00:00.000Z' },
      ],
    };
    const prisma = {
      run: { findMany: async () => [] },
      mission: {
        findMany: async () => [
          { id: 9, sessionId: 'claude:mission-1', fromSession: 'claude:chat-1' },
        ],
      },
    };
    const service = new ChatService(
      {} as never,
      { get: async () => project } as never,
      { connected: async () => [provider] } as never,
      { get: () => root } as never,
      prisma as never,
      {} as never,
      { reason: () => null } as never,
      {} as never,
    );

    const sessions = await service.sessions(1, 1);
    expect(sessions.map((s) => s.sessionId)).toEqual(['claude:chat-1']);
    expect(sessions[0].missionId).toBe(9);
  });
});
