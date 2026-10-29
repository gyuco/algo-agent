import { Injectable, type OnModuleInit } from '@nestjs/common';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Mission, Run } from '../generated/prisma/client.js';
import { RunConfig } from '../runs/run-config.js';
import { RunHandlers } from '../runs/run-handlers.js';
import type {
  PrepareStep,
  RunEventData,
  RunHandler,
  RunOutcome,
} from '../runs/run-types.js';
import { VaultService } from '../vault/vault.service.js';
import {
  ChecksService,
  failureDetail,
  type CheckEvent,
  type CheckName,
  type CheckRequest,
  type CheckResult,
} from './checks.service.js';
import { ForgeService, httpsUrl } from './forge.service.js';
import { GitService } from './git-service.js';
import { missionBranchName, missionWorktreePath } from './mission-paths.js';
import { MissionScheduler } from './mission-scheduler.service.js';
import { MissionsService } from './missions.service.js';
import { planSchema, planTasks } from './plan-schema.js';

const BASE_CHECKS: CheckName[] = ['build', 'lint', 'test'];
/** Yields events pushed while `work` runs, so the output reaches the user live. */
async function* live(
  work: (push: (event: RunEventData) => void) => Promise<CheckResult[] | null>,
): AsyncGenerator<RunEventData, CheckResult[] | null> {
  const queue: RunEventData[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const push = (event: RunEventData) => {
    queue.push(event);
    wake?.();
  };
  const task = work(push).finally(() => {
    done = true;
    wake?.();
  });
  // Keep the rejection for the `await` below, not as an unhandled one.
  task.catch(() => undefined);

  for (;;) {
    while (queue.length) yield queue.shift()!;
    if (done) break;
    await new Promise<void>((resolve) => (wake = resolve));
  }
  return await task;
}

/** The preparation after an approval: branch, worktree, baseline checks, then `running`. */
@Injectable()
export class MissionPrepareHandler implements RunHandler, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly git: GitService,
    private readonly checks: ChecksService,
    private readonly config: RunConfig,
    private readonly vault: VaultService,
    private readonly missions: MissionsService,
    private readonly scheduler: MissionScheduler,
    private readonly forge: ForgeService,
    private readonly handlers: RunHandlers,
  ) {}

  onModuleInit() {
    this.handlers.register('mission-prepare', this);
  }

  async *execute(
    run: Run,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, RunOutcome> {
    if (!run.missionId)
      throw new Error('La preparazione non appartiene a una missione');
    let mission = await this.prisma.mission.findUnique({
      where: { id: run.missionId },
      include: { project: { select: { id: true, path: true } } },
    });
    if (!mission) throw new Error('Missione non trovata');
    // An approval was revised, or the mission was stopped, meanwhile.
    if (mission.status !== 'approved') return 'done';
    if (mission.projectId === null) {
      const created = yield* this.createNewProject(run, mission, signal);
      if (!created) return 'done';
      const refreshed = await this.prisma.mission.findUnique({
        where: { id: mission.id },
        include: { project: { select: { id: true, path: true } } },
      });
      if (!refreshed) return 'done';
      mission = refreshed;
    }
    if (!mission) return 'done';

    const plan = mission.planJson
      ? planSchema.safeParse(JSON.parse(mission.planJson))
      : null;
    const baseBranch = mission.baseBranch;
    if (!plan?.success || !baseBranch) {
      await this.fail(
        run,
        signal,
        'branch',
        'Il piano approvato o il branch base non sono leggibili',
      );
      return 'done';
    }
    const approved = plan.data;
    // §8.3: a repository with only the initial commit has nothing to verify.
    const skipBaseline =
      (await this.git
        .commitCount(mission.project!.path, baseBranch)
        .catch(() => 0)) <= 1;

    // 0. a remote with a token in its URL would expose it to the task agents
    if (await this.git.remoteHasCredentials(mission.project!.path)) {
      const detail =
        "Il remote contiene credenziali: rimuovile dall'URL e usa il vault";
      yield this.step('fetch', 'failed', detail);
      await this.fail(run, signal, 'fetch', detail);
      return 'done';
    }

    // 1. fetch and branch
    yield this.step('fetch', 'started');
    const base = await this.git.baseRef(mission.project!.path, baseBranch);
    if (base.warning) yield { type: 'error', message: base.warning };
    const baseCommit = base.ref
      ? await this.git.revParse(mission.project!.path, base.ref)
      : null;
    if (!baseCommit) {
      yield this.step(
        'fetch',
        'failed',
        `Nessun branch "${baseBranch}" da cui partire`,
      );
      await this.fail(
        run,
        signal,
        'branch',
        `Il branch "${baseBranch}" non esiste in locale né su origin`,
      );
      return 'done';
    }
    yield this.step('fetch', 'done', base.warning);

    const branch =
      mission.branch ?? missionBranchName(mission.id, approved.title);
    yield this.step('branch', 'started', branch);
    try {
      const existing = await this.git.revParse(
        mission.project!.path,
        `refs/heads/${branch}`,
      );
      if (!existing) {
        await this.git.createBranch(mission.project!.path, branch, baseCommit);
      } else if (existing !== baseCommit) {
        const ahead = await this.git.aheadOfRef(
          mission.project!.path,
          `refs/heads/${branch}`,
          baseCommit,
        );
        if (ahead > 0) {
          throw new Error(
            `Il branch ${branch} ha ${ahead} commit propri: non lo sposto`,
          );
        }
        await this.git.moveBranch(mission.project!.path, branch, baseCommit);
      }
      await this.prisma.mission.update({
        where: { id: mission.id },
        data: { branch, baseCommit },
      });
      yield this.step('branch', 'done', branch);
    } catch (error) {
      const detail = message(error);
      yield this.step('branch', 'failed', detail);
      await this.fail(run, signal, 'branch', detail);
      return 'done';
    }

    // 2. worktree
    const dataDir = await this.config.resolvedDataDir();
    const worktree =
      mission.worktreePath ??
      missionWorktreePath(dataDir, mission.projectId!, mission.id);
    yield this.step('worktree', 'started', worktree);
    try {
      await mkdir(dirname(worktree), { recursive: true });
      await this.git.addWorktree(mission.project!.path, worktree, branch);
      await this.prisma.mission.update({
        where: { id: mission.id },
        data: { worktreePath: worktree },
      });
      yield this.step('worktree', 'done', worktree);
    } catch (error) {
      const detail = message(error);
      yield this.step('worktree', 'failed', detail);
      await this.fail(run, signal, 'worktree', detail);
      return 'done';
    }

    // 3. setup and baseline checks, in the sandbox
    const all = await this.vault.variables(mission.userId, mission.projectId!);
    const secrets = Object.fromEntries(
      approved.checks.secrets
        .filter((name) => name in all)
        .map((name) => [name, all[name]]),
    );
    const request: CheckRequest = {
      runId: run.id,
      projectId: mission.projectId!,
      worktree,
      plan: approved,
      names: [],
      secrets,
      signal,
      onEvent: () => undefined,
    };
    const event =
      (name: CheckName) =>
      (e: CheckEvent): RunEventData | null => {
        if (e.type === 'output')
          return { type: 'check_output', name, text: e.text };
        if (e.type === 'started')
          return { type: 'prepare_step', step: name, status: 'started' };
        return {
          type: 'prepare_step',
          step: name,
          status: e.ok ? 'done' : 'failed',
          detail: e.ok ? undefined : `Exit code ${e.exitCode ?? '?'}`,
        };
      };

    const setupResults = yield* live(async (push) => {
      const result = await this.checks.ensureSetup({
        ...request,
        names: ['setup'],
        onEvent: (e) => {
          const mapped = event('setup')(e);
          if (mapped) push(mapped);
        },
      });
      return result ? [result] : [];
    });
    const setup = setupResults?.[0] ?? null;
    if (setup && !setup.ok) {
      await this.fail(run, signal, 'setup', failureDetail(setup), setup.output);
      return 'done';
    }
    // No events when the marker is fresh: say it here.
    if (!setup) yield this.step('setup', 'skipped');

    for (const name of BASE_CHECKS) {
      if (!approved.checks[name] || skipBaseline) yield this.step(name, 'skipped');
    }
    if (skipBaseline) {
      await this.missions.record(mission.id, 'note', {
        text: 'Controllo di base saltato: il branch base contiene solo il commit iniziale.',
      });
    }
    const defined = skippedBaseline(approved, skipBaseline);
    if (defined.length) {
      const results = yield* live((push) =>
        this.checks.run({
          ...request,
          names: defined,
          onEvent: (e) => {
            const mapped = event(e.name)(e);
            if (mapped) push(mapped);
          },
        }),
      );
      const failed = results?.find((r) => !r.ok);
      if (failed) {
        if (signal.aborted) return 'done';
        await this.fail(
          run,
          signal,
          failed.name,
          failureDetail(failed),
          failed.output,
        );
        return 'done';
      }
    }
    if (signal.aborted) return 'done';

    // 4. ready, with the rows of the plan's tasks, in the same transaction
    const { count } = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.mission.updateMany({
        where: { id: mission.id, userId: mission.userId, status: 'approved' },
        data: { status: 'running', waitJson: null },
      });
      if (!moved.count) return moved;
      await tx.missionTask.createMany({
        data: planTasks(approved).map((task) => ({
          missionId: mission.id,
          key: task.key,
          milestone: task.milestone,
          status: 'pending',
        })),
      });
      return moved;
    });
    if (count) {
      await this.missions.record(mission.id, 'status', { status: 'running' });
      this.scheduler.wake(mission.id);
    }
    return 'done';
  }

  /**
   * §8.3: the folder, the local repository, the remote one and the Project of a
   * mission that started from nothing. Every step checks what is done already,
   * so the reconciliation can resume from the middle.
   */
  private async *createNewProject(
    run: Run,
    mission: Mission,
    signal: AbortSignal,
  ): AsyncGenerator<RunEventData, Mission | null> {
    const info = (mission.newProjectJson
      ? JSON.parse(mission.newProjectJson)
      : {}) as {
      name?: string;
      forge?: 'github' | 'gitlab';
      namespace?: string;
      visibility?: 'private' | 'internal' | 'public';
    };
    const name = info.name;
    const forgeKind = info.forge ?? 'github';
    const baseBranch = mission.baseBranch ?? 'main';
    if (!name) {
      await this.fail(run, signal, 'create_folder', 'Il nome del progetto manca');
      return null;
    }
    const folder = join(this.config.workspaceRoot(), name);

    yield this.step('create_folder', 'started', folder);
    try {
      await mkdir(folder);
    } catch {
      const entries = await readdir(folder).catch(() => null);
      if (!entries || entries.length > 0) {
        const detail =
          entries === null
            ? `La cartella ${folder} non si può creare`
            : `La cartella ${folder} esiste già e non è vuota`;
        yield this.step('create_folder', 'failed', detail);
        await this.fail(run, signal, 'create_folder', detail);
        return null;
      }
    }
    yield this.step('create_folder', 'done', folder);

    yield this.step('git_init', 'started', baseBranch);
    try {
      if (!(await this.git.isRepository(folder))) {
        await this.git.initRepo(folder, baseBranch);
      }
      if ((await this.git.commitCount(folder, baseBranch)) === 0) {
        await this.git.commitEmpty(folder, 'Initial commit');
      }
      yield this.step('git_init', 'done', baseBranch);
    } catch (error) {
      const detail = message(error);
      yield this.step('git_init', 'failed', detail);
      await this.fail(run, signal, 'git_init', detail);
      return null;
    }

    const variables = await this.vault.variables(run.userId, mission.projectId);
    const tokenName = forgeKind === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN';
    const token = variables[tokenName];

    yield this.step('create_repo', 'started');
    let remote = await this.git.remoteUrl(folder);
    if (!remote) {
      if (!token) {
        const detail = `Manca ${tokenName} nel vault: aggiungilo e riprova`;
        yield this.step('create_repo', 'failed', detail);
        await this.fail(run, signal, 'create_repo', detail);
        return null;
      }
      try {
        const created = await this.forge.createRepo(forgeKind, token, {
          name,
          ...(info.namespace ? { namespace: info.namespace } : {}),
          visibility: info.visibility ?? 'private',
          ...(forgeKind === 'gitlab'
            ? {
                apiBase: variables.GITLAB_URL
                  ? `${variables.GITLAB_URL.replace(/\/+$/, '')}/api/v4`
                  : 'https://gitlab.com/api/v4',
              }
            : {}),
        });
        remote = created.httpsUrl;
        await this.git.addRemote(folder, 'origin', remote);
        yield this.step('create_repo', 'done', remote);
      } catch (error) {
        const detail = message(error);
        yield this.step('create_repo', 'failed', detail);
        await this.fail(run, signal, 'create_repo', detail);
        return null;
      }
    } else {
      yield this.step('create_repo', 'skipped', remote);
    }

    yield this.step('push_base', 'started', baseBranch);
    if (!token) {
      const detail = `Manca ${tokenName} nel vault: aggiungilo e riprova`;
      yield this.step('push_base', 'failed', detail);
      await this.fail(run, signal, 'push_base', detail);
      return null;
    }
    try {
      await this.git.push(folder, httpsUrl(remote), baseBranch, {
        kind: forgeKind,
        token,
      });
      yield this.step('push_base', 'done');
    } catch (error) {
      const detail = message(error);
      yield this.step('push_base', 'failed', detail);
      await this.fail(run, signal, 'push_base', detail);
      return null;
    }

    yield this.step('register_project', 'started');
    try {
      const path = await realpath(folder);
      let project = await this.prisma.project.findFirst({
        where: { userId: run.userId, path },
        select: { id: true, path: true },
      });
      if (!project) {
        project = await this.prisma.project.create({
          data: { userId: run.userId, name, path },
          select: { id: true, path: true },
        });
      }
      await this.prisma.mission.update({
        where: { id: mission.id },
        data: { projectId: project.id },
      });
      await this.prisma.run.updateMany({
        where: { missionId: mission.id },
        data: { projectId: project.id },
      });
      yield this.step('register_project', 'done', path);
    } catch (error) {
      const detail = message(error);
      yield this.step('register_project', 'failed', detail);
      await this.fail(run, signal, 'register_project', detail);
      return null;
    }
    return this.prisma.mission.findUnique({ where: { id: mission.id } });
  }

  private step(
    step: PrepareStep,
    status: 'started' | 'done' | 'failed' | 'skipped',
    detail?: string,
  ): RunEventData {
    return {
      type: 'prepare_step',
      step,
      status,
      ...(detail ? { detail } : {}),
    };
  }

  /** Moves the mission to `waiting { baseline }` and records why. */
  private async fail(
    run: Run,
    signal: AbortSignal,
    step: PrepareStep,
    detail: string,
    output?: string,
  ) {
    // The user stopped the mission: leave its state to `abort`.
    if (!run.missionId || signal.aborted) return;
    const wait = { code: 'baseline', runId: run.id, step, detail };
    const { count } = await this.prisma.mission.updateMany({
      where: { id: run.missionId, status: 'approved' },
      data: { status: 'waiting', waitJson: JSON.stringify(wait) },
    });
    if (count) {
      await this.missions.record(
        run.missionId,
        'wait',
        { ...wait, ...(output ? { output } : {}) },
        { notify: true },
      );
    }
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function skippedBaseline(plan: { checks: Record<string, unknown> }, skip: boolean) {
  if (skip) return [];
  return BASE_CHECKS.filter((name) => plan.checks[name]);
}
