import { ConflictException } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';

const project = { id: 2, userId: 1, name: 'P', path: '/repo' };

function service(
  missions: { status: string; branch?: string; worktreePath?: string }[],
) {
  const prisma = {
    project: {
      findFirst: async () => project,
      delete: vi.fn(async () => project),
    },
    mission: { findMany: async () => missions.map((m) => ({ id: 7, ...m })) },
  };
  const git = {
    removeWorktree: vi.fn(async () => undefined),
    deleteBranch: vi.fn(async () => undefined),
  };
  const moduleRef = { get: () => git };
  const projects = new ProjectsService(
    prisma as never,
    {} as never,
    moduleRef as never,
  );
  return { projects, prisma, git };
}

describe('ProjectsService.remove', () => {
  it('refuses while a mission is preparing or running', async () => {
    for (const status of ['approved', 'running', 'waiting']) {
      const { projects, prisma } = service([{ status }]);
      await expect(projects.remove(1, 2)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.project.delete).not.toHaveBeenCalled();
    }
  });

  it('cleans the worktrees and branches of finished missions first', async () => {
    const { projects, git } = service([
      {
        status: 'aborted',
        branch: 'mission/7-login',
        worktreePath: '/data/worktrees/2/7/main',
      },
    ]);
    await projects.remove(1, 2);
    expect(git.removeWorktree).toHaveBeenCalledWith(
      '/repo',
      '/data/worktrees/2/7/main',
    );
    expect(git.deleteBranch).toHaveBeenCalledWith('/repo', 'mission/7-login');
  });
});
