import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Mission, Run } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { RunHandlers } from '../runs/run-handlers.js';
import type {
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { VaultService } from '../vault/vault.service.js';
import { detect, ForgeError, ForgeService, httpsUrl } from './forge.service.js';
import { GitService } from './git-service.js';
import { MissionsService } from './missions.service.js';
import { planSchema } from './plan-schema.js';
import { prBody } from './pr-body.js';

/** §6.3: publishes the mission's branch and opens the pull request. */
@Injectable()
export class MissionPublishHandler implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly git: GitService,
    private readonly vault: VaultService,
    private readonly forge: ForgeService,
    private readonly missions: MissionsService,
    private readonly handlers: RunHandlers,
  ) {}

  onModuleInit() {
    this.handlers.register('mission-publish', this);
  }

  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    if (!run.missionId) throw new Error('Il run non appartiene a una missione');
    const mission = await this.prisma.mission.findUnique({
      where: { id: run.missionId },
    });
    if (!mission || mission.status !== 'integrating') return 'done';
    const project = await this.projects.get(mission.userId, mission.projectId!);
    const branch = mission.branch;
    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    if (!branch || !plan?.success) {
      await this.wait(mission, 'push', 'Il branch o il piano non sono leggibili');
      return 'done';
    }

    const remote = await this.git.remoteUrl(project.path);
    const variables = await this.vault.variables(
      mission.userId,
      mission.projectId!,
    );
    const forge = remote ? detect(remote, variables.GITLAB_URL) : null;
    if (!remote || !forge) {
      // No origin, or a forge the app doesn't know: the branch stays local.
      await this.done(mission, null);
      await this.missions.record(
        mission.id,
        'note',
        {
          text: remote
            ? `Il remote ${remote} non è GitHub o GitLab: il branch resta locale.`
            : 'Nessun origin: il branch resta locale.',
        },
        {},
      );
      return 'done';
    }

    const tokenName = forge.kind === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN';
    const token = variables[tokenName];
    if (!token) {
      await this.wait(
        mission,
        'token',
        `Manca ${tokenName} nel vault: aggiungilo e riprova.`,
      );
      return 'done';
    }

    yield { type: 'publish_step', step: 'push', status: 'started' };
    try {
      await this.git.push(project.path, httpsUrl(remote), branch, {
        kind: forge.kind,
        token,
      });
      yield { type: 'publish_step', step: 'push', status: 'done' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      yield { type: 'publish_step', step: 'push', status: 'failed', detail };
      if (!signal.aborted) await this.wait(mission, 'push', detail);
      return 'done';
    }
    if (signal.aborted) return 'done';

    yield { type: 'publish_step', step: 'pr', status: 'started' };
    try {
      const base = mission.baseBranch ?? plan.data.baseBranch ?? 'main';
      const existing = await this.forge.findOpenPr(
        forge,
        token,
        branch,
        base,
      );
      let url: string;
      if (existing) {
        url = existing.url;
      } else {
        const tasks = await this.prisma.missionTask.findMany({
          where: { missionId: mission.id },
        });
        const entries = await this.prisma.missionEntry.findMany({
          where: { missionId: mission.id },
          orderBy: { id: 'asc' },
        });
        const created = await this.forge.createPr(forge, token, {
          head: branch,
          base,
          title: mission.title,
          body: prBody(mission, plan.data, tasks, entries),
        });
        url = created.url;
      }
      yield { type: 'publish_step', step: 'pr', status: 'done', detail: url };
      await this.done(mission, url);
      await this.cleanTaskWorktrees(mission, project.path);
      return 'done';
    } catch (error) {
      const detail =
        error instanceof ForgeError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      yield { type: 'publish_step', step: 'pr', status: 'failed', detail };
      if (!signal.aborted) await this.wait(mission, 'pr', detail);
      return 'done';
    }
  }

  /** A local or published end: the mission is done and says where the work is. */
  private async done(mission: Mission, prUrl: string | null) {
    const { count } = await this.prisma.mission.updateMany({
      where: { id: mission.id, status: 'integrating' },
      data: {
        status: 'done',
        finishedAt: new Date(),
        waitJson: null,
        ...(prUrl ? { prUrl } : {}),
      },
    });
    if (!count) return;
    await this.missions.record(
      mission.id,
      'status',
      { status: 'done', branch: mission.branch, prUrl },
      { notify: true },
    );
    await this.missions.record(
      mission.id,
      prUrl ? 'pr' : 'final',
      prUrl ? { url: prUrl } : { branch: mission.branch, local: true },
      { notify: true },
    );
  }

  /** §6.3: push or forge failure, with Retry. */
  private async wait(mission: Mission, step: string, detail: string) {
    const wait = { code: 'publish', step, detail };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: mission.id, status: 'integrating' },
      data: { status: 'waiting', waitJson: JSON.stringify(wait) },
    });
    if (!count) return;
    await this.missions.record(mission.id, 'wait', wait, { notify: true });
  }

  /** §8.4: on `done` the task worktrees go; the local branches stay. */
  private async cleanTaskWorktrees(mission: Mission, projectPath: string) {
    const tasks = await this.prisma.missionTask.findMany({
      where: { missionId: mission.id, worktreePath: { not: null } },
    });
    for (const task of tasks) {
      if (!task.worktreePath) continue;
      await this.git
        .removeWorktree(projectPath, task.worktreePath)
        .catch(() => undefined);
      await this.prisma.missionTask
        .update({ where: { id: task.id }, data: { worktreePath: null } })
        .catch(() => undefined);
    }
  }
}
