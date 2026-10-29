import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RunConfig } from '../runs/run-config.js';

/** Whether missions may run checks on this machine, and why not. */
export interface SandboxResult {
  available: boolean;
  reason?: string;
}

/** What one command sees of the filesystem and the network. */
export interface SandboxSpec {
  /** The mission's or task's worktree: the only tree it may write. */
  worktree: string;
  /** Its own folder for `HOME`, `TMPDIR` and the profile. */
  tmp: string;
  /** The shared npm cache. */
  cache: string;
  /** The backend's data folder, worktrees included: denied as a whole. */
  dataDir: string;
  /** The real home, used only for the deny rules. */
  home: string;
  /** The project's `.git`, which a worktree needs to read. */
  projectGit: string;
  /** Every project folder of the instance: denied, metadata aside. */
  projects: string[];
  /** True only for `checks.setup`. */
  network: boolean;
}

/** A wrapped command line, ready for `spawn(command, args, { shell: false })`. */
export interface SandboxCommand {
  command: string;
  args: string[];
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PROBE_DIR = 'sandbox-probe';
const AUTOTEST_TTL_MS = 10 * 60 * 1000;
const HOME_DENY = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  '.claude',
  '.docker',
  '.kube',
  'Library/Keychains',
];
const HOME_DENY_FILES = [
  '.claude.json',
  '.npmrc',
  '.netrc',
  '.git-credentials',
];

const escape = (path: string) => path.replace(/"/g, '\\"');

/**
 * Runs the plan's commands isolated. There is no fallback without isolation:
 * when `available()` is false, missions can't be approved.
 */
export abstract class Sandbox {
  abstract available(): Promise<SandboxResult>;
  abstract wrap(argv: string[], spec: SandboxSpec): SandboxCommand;
}

/**
 * macOS `sandbox-exec`: a profile generated for every run, with the paths as
 * `-D` parameters, never interpolated into the profile text.
 */
@Injectable()
export class MacSandbox extends Sandbox implements OnModuleInit {
  private readonly logger = new Logger(MacSandbox.name);
  private cached: { at: number; result: SandboxResult } | null = null;
  private profiles = 0;

  constructor(private readonly config: RunConfig) {
    super();
  }

  /** Warms the autotest at startup, so Approve finds the answer ready. */
  onModuleInit() {
    void this.available();
  }

  async available(): Promise<SandboxResult> {
    if (this.cached && Date.now() - this.cached.at < AUTOTEST_TTL_MS) {
      return this.cached.result;
    }
    const result = await this.detect();
    this.cached = { at: Date.now(), result };
    if (!result.available)
      this.logger.warn(`Sandbox unavailable: ${result.reason}`);
    return result;
  }

  /** Forgets the last autotest, e.g. in tests or after fixing the machine. */
  invalidate() {
    this.cached = null;
  }

  private async detect(): Promise<SandboxResult> {
    if (process.platform !== 'darwin') {
      return {
        available: false,
        reason:
          'Il sandbox dei controlli è disponibile solo su macOS in questa fase',
      };
    }
    if (!existsSync(SANDBOX_EXEC)) {
      return {
        available: false,
        reason: 'sandbox-exec non è installato su questo sistema',
      };
    }

    const dataDir = await this.config.resolvedDataDir();
    const probeDir = join(dataDir, PROBE_DIR);
    await mkdir(probeDir, { recursive: true });
    const probe = join(probeDir, 'probe.txt');
    await writeFile(probe, 'sandbox probe');
    await mkdir(join(dataDir, 'sandbox-tmp'), { recursive: true });
    const tmp = await mkdtemp(join(dataDir, 'sandbox-tmp', 'autotest-'));
    try {
      const spec: SandboxSpec = {
        worktree: tmp,
        tmp,
        cache: tmp,
        dataDir,
        home: homedir(),
        projectGit: tmp,
        projects: [],
        network: false,
      };

      if (!(await this.denied(['/bin/cat', probe], spec))) {
        return {
          available: false,
          reason: 'il sandbox non nega la lettura dei dati del backend',
        };
      }
      if (
        !(await this.denied(
          ['/usr/bin/nc', '-z', '-w', '2', '1.1.1.1', '443'],
          spec,
        ))
      ) {
        return {
          available: false,
          reason: 'il sandbox non chiude la rete',
        };
      }
      const write = join(tmp, 'write-ok');
      if (
        !(await this.allowed(['/usr/bin/touch', write], spec)) ||
        !existsSync(write)
      ) {
        return {
          available: false,
          reason:
            'il sandbox non permette di scrivere nella cartella temporanea',
        };
      }
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: `la prova del sandbox è fallita: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private run(command: string, args: string[], spec: SandboxSpec) {
    const wrapped = this.wrap([command, ...args], spec);
    return new Promise<{ ok: boolean; stderr: string }>((resolve) => {
      execFile(
        wrapped.command,
        wrapped.args,
        { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, _stdout, stderr) =>
          resolve({ ok: !error, stderr: String(stderr ?? '') }),
      );
    });
  }

  private async denied(argv: string[], spec: SandboxSpec) {
    return !(await this.run(argv[0], argv.slice(1), spec)).ok;
  }

  private async allowed(argv: string[], spec: SandboxSpec) {
    return (await this.run(argv[0], argv.slice(1), spec)).ok;
  }

  /** The profile, as text: every path is a `-D` parameter. */
  profile(spec: SandboxSpec) {
    const params = (name: string, paths: string[]) =>
      paths.map((_, i) => `(subpath (param "${name}_${i}"))`).join(' ');

    const denyRead = [
      ...HOME_DENY.map(
        (dir) => `  (subpath (string-append (param "HOME") "/${dir}"))`,
      ),
      ...HOME_DENY_FILES.map(
        (file) => `  (literal (string-append (param "HOME") "/${file}"))`,
      ),
      '  (subpath (param "DATA_DIR"))',
      ...spec.projects.map((_, i) => `  (subpath (param "PROJECT_${i}"))`),
    ].join('\n');

    const metadata = spec.projects.length
      ? `\n(allow file-read-metadata ${params('PROJECT', spec.projects)})`
      : '';

    return `(version 1)
(allow default)

; write: only the worktree, its temporary folder and the shared cache
(deny file-write*)
(allow file-write*
  (subpath (param "WORKTREE"))
  (subpath (param "TMP"))
  (subpath (param "CACHE"))
  (literal "/dev/null") (literal "/dev/zero")
  (regex #"^/dev/tty")
  (regex #"^/dev/fd/"))

; read: no credentials, no backend data, no other project
(deny file-read*
${denyRead})

; the rules below win: the worktree, the cache and the project's .git stay readable
(allow file-read*
  (subpath (param "WORKTREE"))
  (subpath (param "TMP"))
  (subpath (param "CACHE"))
  (subpath (param "PROJECT_GIT")))
; git and npm need to stat these parents (TMP sits under DATA_DIR), not to read them
(allow file-read-metadata (subpath (param "PROJECT_GIT")))
(allow file-read-metadata (subpath (param "DATA_DIR")))${metadata}

; network: localhost only, and everything only in setup
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))${spec.network ? '\n(allow network-outbound)' : ''}
`;
  }

  wrap(argv: string[], spec: SandboxSpec): SandboxCommand {
    mkdirSync(spec.tmp, { recursive: true });
    // The kernel compares resolved paths: /var is /private/var on macOS.
    const real = (path: string) => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    };
    spec = {
      ...spec,
      worktree: real(spec.worktree),
      tmp: real(spec.tmp),
      cache: real(spec.cache),
      dataDir: real(spec.dataDir),
      home: real(spec.home),
      projectGit: real(spec.projectGit),
      projects: spec.projects.map(real),
    };
    const profile = join(
      spec.tmp,
      `profile-${process.pid}-${++this.profiles}.sb`,
    );
    writeFileSync(profile, this.profile(spec));

    const params = [
      `WORKTREE=${spec.worktree}`,
      `TMP=${spec.tmp}`,
      `CACHE=${spec.cache}`,
      `DATA_DIR=${spec.dataDir}`,
      `HOME=${escape(spec.home)}`,
      `PROJECT_GIT=${spec.projectGit}`,
      ...spec.projects.map((path, i) => `PROJECT_${i}=${path}`),
    ];
    return {
      command: SANDBOX_EXEC,
      args: [
        '-f',
        profile,
        ...params.flatMap((param) => ['-D', param]),
        '--',
        ...argv,
      ],
    };
  }
}
