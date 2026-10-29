import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isInside } from '../chat/workspace.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RunConfig } from '../runs/run-config.js';
import { parseCommand, testFilterArgs } from './command-line.js';
import { GitService } from './git-service.js';
import { realPath, setupMarker } from './mission-paths.js';
import { commandText, type Plan } from './plan-schema.js';
import { Sandbox, type SandboxSpec } from './sandbox.js';

export type CheckName = 'setup' | 'build' | 'lint' | 'test';

export const CHECK_NAMES = ['setup', 'build', 'lint', 'test'] as const;

/** What a command emits while it runs. */
export type CheckEvent =
  | { type: 'started'; name: CheckName; argv: string[] }
  | { type: 'output'; name: CheckName; text: string }
  | {
      type: 'finished';
      name: CheckName;
      ok: boolean;
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
    };

export interface CheckRequest {
  /** The run the commands belong to: names their temporary folder. */
  runId?: number;
  projectId: number;
  /** Absolute, resolved, under `DATA_DIR/worktrees`. */
  worktree: string;
  plan: Plan;
  /** In order; ones the plan doesn't define are skipped. */
  names: CheckName[];
  /** Only with `plan.checks.testFilter`. */
  testPattern?: string;
  /** Values of `checks.secrets`, from the vault. */
  secrets: Record<string, string>;
  signal: AbortSignal;
  onEvent?: (event: CheckEvent) => void;
}

export interface CheckResult {
  name: CheckName;
  argv: string[];
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** stdout+stderr interleaved, the last N KB, secrets masked. */
  output: string;
}

const DETAIL_LINES = 5;
const DETAIL_LENGTH = 500;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Where a runner's error report starts: vitest/jest, tsc, npm, thrown errors. */
const FAILURE_START = /^(FAIL\b|ERROR\b|npm ERR!|npm error\b|\w*Error:)|error TS\d+/;

/**
 * A short, readable reason from a command's output, for waits and entries:
 * from the first line of the error report, or from the start when none is found
 * (the head of a test run is a banner, the failure comes later).
 */
export function failureDetail(result: CheckResult) {
  const lines = result.output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const start = Math.max(
    0,
    lines.findIndex((line) => FAILURE_START.test(line)),
  );
  const detail = lines
    .slice(start, start + DETAIL_LINES)
    .join('\n')
    .slice(0, DETAIL_LENGTH);
  if (result.timedOut)
    return ['Timeout del comando', detail].filter(Boolean).join('\n');
  return detail || `Exit code ${result.exitCode ?? 'sconosciuto'}`;
}

/** The lockfiles whose content decides whether `setup` must run again. */
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const SETUP_MARK_VERSION = 1;
const KILL_GRACE_MS = 5_000;

/** A mutex in memory: one instance, like the event bus. */
class Mutex {
  private tail = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Runs the plan's commands: `spawn` with `shell: false` inside the sandbox,
 * minimal environment, timeout, tail of the output, secrets masked, and the
 * locks that keep two checks off the same worktree or the same project.
 */
@Injectable()
export class ChecksService {
  private readonly worktreeLocks = new Map<string, Mutex>();
  private readonly projectLocks = new Map<number, Mutex>();
  private tmpCounter = 0;

  constructor(
    private readonly config: RunConfig,
    private readonly sandbox: Sandbox,
    private readonly git: GitService,
    private readonly prisma: PrismaService,
  ) {}

  private timeoutMs() {
    return this.config.missionCheckTimeoutMs();
  }

  private outputBytes() {
    return this.config.missionCheckOutputKb() * 1024;
  }

  /** Runs the requested commands, stopping at the first failure. */
  async run(req: CheckRequest): Promise<CheckResult[]> {
    const projectPaths = await this.prisma.project
      .findMany({ select: { path: true } })
      .then((rows) => rows.map((r) => r.path));

    return this.withLocks(req, async () => {
      const results: CheckResult[] = [];
      for (const name of req.names) {
        const result =
          name === 'setup'
            ? await this.setupIfStale(req, projectPaths)
            : await this.runCommand(req, name, projectPaths);
        if (!result) continue;
        results.push(result);
        if (!result.ok) break;
      }
      return results;
    });
  }

  /**
   * Runs `checks.setup` only when its marker is missing or a lockfile changed.
   * Null when it didn't run (no setup command, or already done).
   */
  async ensureSetup(req: CheckRequest): Promise<CheckResult | null> {
    const projectPaths = await this.prisma.project
      .findMany({ select: { path: true } })
      .then((rows) => rows.map((r) => r.path));
    return this.withLocks(req, () => this.setupIfStale(req, projectPaths));
  }

  private async withLocks<T>(req: CheckRequest, fn: () => Promise<T>) {
    // Project first, then worktree: always this order, so two checks can't deadlock.
    const project = req.plan.checks.parallel
      ? null
      : this.lock(this.projectLocks, req.projectId);
    const worktree = this.lock(
      this.worktreeLocks,
      await realPath(req.worktree),
    );

    const locked = <T>(mutex: Mutex | null, next: () => Promise<T>) =>
      mutex ? mutex.run(next) : next();

    return locked(project, () => locked(worktree, fn));
  }

  private lock<K>(locks: Map<K, Mutex>, key: K) {
    let mutex = locks.get(key);
    if (!mutex) locks.set(key, (mutex = new Mutex()));
    return mutex;
  }

  private async setupIfStale(
    req: CheckRequest,
    projectPaths: string[],
  ): Promise<CheckResult | null> {
    const command = req.plan.checks.setup;
    if (!command) return null;
    const argv = await this.argv(req, 'setup', commandText(command));
    const workdir = await this.workdir(req, command);
    if (!workdir) {
      return this.workdirFailure(req, 'setup', argv);
    }
    const markerPath = setupMarker(req.worktree);
    const digest = await this.setupDigest(workdir, argv);
    const current = await readFile(markerPath, 'utf8')
      .then((text) => JSON.parse(text) as { version?: number; digest?: string })
      .catch(() => null);
    if (current?.version === SETUP_MARK_VERSION && current.digest === digest) {
      return null;
    }

    const result = await this.execute(
      req,
      'setup',
      argv,
      workdir,
      projectPaths,
      true,
    );
    if (result.ok) {
      await writeFile(
        markerPath,
        JSON.stringify({ version: SETUP_MARK_VERSION, digest }),
      );
    }
    return result;
  }

  private async setupDigest(workdir: string, argv: string[]) {
    const hash = createHash('sha256');
    hash.update(argv.join('\0'));
    for (const name of LOCKFILES) {
      const path = join(workdir, name);
      if (!existsSync(path)) continue;
      hash.update(name);
      hash.update(await readFile(path));
    }
    return hash.digest('hex');
  }

  private async argv(req: CheckRequest, name: CheckName, text: string) {
    const argv = parseCommand(text);
    if (name === 'test' && req.testPattern && req.plan.checks.testFilter) {
      argv.push(...testFilterArgs(req.plan.checks.testFilter, req.testPattern));
    }
    if (
      name === 'setup' &&
      req.plan.scope.dependencies.length &&
      installing(argv)
    ) {
      argv.push('--ignore-scripts');
    }
    return argv;
  }

  /** The command's folder, checked inside the worktree after resolving symlinks. */
  private async workdir(
    req: CheckRequest,
    command: string | { run: string; workdir?: string },
  ): Promise<string | null> {
    const relative =
      typeof command === 'string'
        ? req.plan.checks.workdir
        : (command.workdir ?? req.plan.checks.workdir);
    const worktree = await realPath(req.worktree);
    if (!relative) return worktree;
    const path = await realPath(join(worktree, relative));
    return isInside(worktree, path) && existsSync(path) ? path : null;
  }

  private workdirFailure(
    req: CheckRequest,
    name: CheckName,
    argv: string[],
  ): CheckResult {
    const result: CheckResult = {
      name,
      argv,
      ok: false,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      output: 'La cartella di lavoro del comando non esiste nel worktree',
    };
    req.onEvent?.({ type: 'output', name, text: result.output });
    req.onEvent?.({
      type: 'finished',
      name,
      ok: false,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
    });
    return result;
  }

  private async runCommand(
    req: CheckRequest,
    name: CheckName,
    projectPaths: string[],
  ): Promise<CheckResult | null> {
    const command = req.plan.checks[name];
    if (!command) return null;
    const argv = await this.argv(req, name, commandText(command));
    const workdir = await this.workdir(req, command);
    if (!workdir) return this.workdirFailure(req, name, argv);
    return this.execute(req, name, argv, workdir, projectPaths, false);
  }

  /** Spawns one command in the sandbox and collects its tail. */
  private async execute(
    req: CheckRequest,
    name: CheckName,
    argv: string[],
    cwd: string,
    projectPaths: string[],
    network: boolean,
  ): Promise<CheckResult> {
    const dataDir = await this.config.resolvedDataDir();
    const tmp = join(
      dataDir,
      'sandbox-tmp',
      `${req.runId ?? 'manual'}-${++this.tmpCounter}`,
    );
    const cache = join(dataDir, 'sandbox-cache', 'npm');
    await mkdir(tmp, { recursive: true });
    await mkdir(cache, { recursive: true });

    const spec: SandboxSpec = {
      worktree: await realPath(req.worktree),
      tmp,
      cache,
      dataDir,
      home: homedir(),
      projectGit:
        (await this.git.gitDirFor(req.worktree)) ?? join(req.worktree, '.git'),
      projects: projectPaths.map((p) => p).filter(Boolean),
      network,
    };
    const wrapped = this.sandbox.wrap(argv, spec);

    // Secrets first: a secret named PATH or HOME must not undo the sandbox's own values.
    const env: NodeJS.ProcessEnv = {
      ...req.secrets,
      PATH: process.env.PATH ?? '',
      HOME: tmp,
      TMPDIR: tmp,
      CI: '1',
      npm_config_cache: cache,
      LANG: 'en_US.UTF-8',
    };
    const startedAt = Date.now();
    req.onEvent?.({ type: 'started', name, argv });

    const secrets = Object.values(req.secrets)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const mask = (text: string) =>
      secrets.reduce((out, secret) => out.split(secret).join('***'), text);

    const maxBytes = this.outputBytes();
    let output = '';
    let timedOut = false;
    // Live output keeps back the last chars that could start a secret split across chunks.
    const holdBack = Math.max(0, (secrets[0]?.length ?? 0) - 1);
    let pending = '';

    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const emit = (text: string) => {
      if (!text) return;
      output += text;
      if (Buffer.byteLength(output) > maxBytes) {
        output = Buffer.from(output).subarray(-maxBytes).toString('utf8');
      }
      req.onEvent?.({ type: 'output', name, text });
    };
    const append = (chunk: Buffer) => {
      const text = mask(pending + chunk.toString('utf8'));
      const cut = Math.max(0, text.length - holdBack);
      pending = text.slice(cut);
      emit(text.slice(0, cut));
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const timeoutMs = this.timeoutMs();
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    timer.unref();
    const onAbort = () => {
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
    };
    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener('abort', onAbort, { once: true });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        append(Buffer.from(`${error.message}\n`));
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    emit(mask(pending));
    pending = '';

    clearTimeout(timer);
    req.signal.removeEventListener('abort', onAbort);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);

    const result: CheckResult = {
      name,
      argv,
      ok: exitCode === 0 && !timedOut,
      exitCode,
      timedOut,
      durationMs: Date.now() - startedAt,
      // Masked again as a whole: a secret may straddle two chunks.
      output: mask(output),
    };
    req.onEvent?.({
      type: 'finished',
      name,
      ok: result.ok,
      exitCode,
      timedOut,
      durationMs: result.durationMs,
    });
    return result;
  }
}

/** Whether `argv` installs dependencies. */
function installing(argv: string[]) {
  const [tool, action] = argv;
  if (tool === 'npm') return ['ci', 'install', 'i'].includes(action ?? '');
  if (tool === 'pnpm') return ['install', 'i'].includes(action ?? '');
  if (tool === 'yarn') return action === undefined || action === 'install';
  return false;
}
