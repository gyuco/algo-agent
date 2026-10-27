import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { listFolders, resolveWorkspace } from '../chat/workspace.js';
import { ProjectDto } from './dto/project.dto.js';

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  path: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

  async create(userId: number, dto: ProjectDto) {
    const path = await resolveWorkspace(dto.path, this.workspaceRoot());
    return this.unique(() =>
      this.prisma.project.create({
        data: { userId, name: dto.name, path },
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
        data: { name: dto.name, path },
        select: PUBLIC_FIELDS,
      }),
    );
  }

  async remove(userId: number, id: number) {
    await this.findOwned(userId, id);
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
