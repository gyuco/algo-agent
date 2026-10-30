import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { listFolders, resolveWorkspace } from '../chat/workspace.js';
import { GitService } from '../missions/git-service.js';
import { setupMarker } from '../missions/mission-paths.js';
import { ProjectDto } from './dto/project.dto.js';

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  path: true,
  color: true,
  logo: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  list(userId: number) {
    return this.prisma.project.findMany({
      where: { userId },
      select: PUBLIC_FIELDS,
      orderBy: { name: 'asc' },
    });
  }

  async get(userId: number, id: number) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
      select: PUBLIC_FIELDS,
    });
    if (!project) throw new NotFoundException('Progetto non trovato');
    return project;
  }

  /** §8.5: whether WORKSPACE_ROOT/`name` is free for a new project. */
  folderAvailable(name: string) {
    const valid = /^[a-z0-9][a-z0-9-_.]{0,99}$/.test(name);
    return {
      available: valid && !existsSync(join(this.workspaceRoot(), name)),
      ...(valid ? {} : { reason: 'nome non valido' }),
    };
  }

  async create(userId: number, dto: ProjectDto) {
    const path = await resolveWorkspace(dto.path, this.workspaceRoot());
    return this.unique(() =>
      this.prisma.project.create({
        data: {
          userId,
          name: dto.name,
          path,
          color: dto.color ?? null,
          logo: dto.logo ?? null,
        },
        select: PUBLIC_FIELDS,
      }),
    );
  }

  async update(userId: number, id: number, dto: ProjectDto) {
    await this.findOwned(userId, id);
    const path = await resolveWorkspace(dto.path, this.workspaceRoot());
    return this.unique(() =>
      this.prisma.project.update({
        where: { id },
        data: {
          name: dto.name,
          path,
          // Absent fields stay as they are; an empty one clears the setting.
          color: dto.color,
          logo: dto.logo,
        },
        select: PUBLIC_FIELDS,
      }),
    );
  }

  async remove(userId: number, id: number) {
    const project = await this.findOwned(userId, id);
    const missions = await this.prisma.mission.findMany({
      where: { projectId: id },
      select: { id: true, status: true, branch: true, worktreePath: true },
    });
    // A mission still preparing or running would lose its worktree under it.
    if (
      missions.some((m) =>
        ['approved', 'running', 'waiting'].includes(m.status),
      )
    ) {
      throw new ConflictException(
        'Il progetto ha una missione in corso: fermala prima di cancellarlo',
      );
    }

    const git = this.moduleRef.get(GitService, { strict: false });
    for (const mission of missions) {
      if (mission.worktreePath) {
        await git
          .removeWorktree(project.path, mission.worktreePath)
          .catch(() => undefined);
        await rm(setupMarker(mission.worktreePath), { force: true }).catch(
          () => undefined,
        );
      }
      if (mission.branch) {
        await git
          .deleteBranch(project.path, mission.branch)
          .catch(() => undefined);
      }
    }

    await this.prisma.project.delete({ where: { id } });
  }

  /** Folders under `path` (default: the workspace root), for the path picker. */
  async browse(path?: string) {
    const root = await realpath(this.workspaceRoot());
    return listFolders(path ? await resolveWorkspace(path, root) : root, root);
  }

  private async findOwned(userId: number, id: number) {
    const project = await this.prisma.project.findFirst({
      where: { id, userId },
    });
    if (!project) throw new NotFoundException('Progetto non trovato');
    return project;
  }

  private async unique<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Esiste già un progetto con questo path');
      }
      throw error;
    }
  }
}
