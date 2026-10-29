import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/** A git command the backend ran and that failed. */
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')}: ${stderr || `exit ${code ?? '?'}`}`);
    this.name = 'GitError';
  }
}

/** A changed file, as the perimeter and the task diff read it. */
export interface DiffEntry {
  /** A, M, D, R, C, T… as `git diff --name-status` prints it. */
  status: string;
  file: string;
  /** The old path of a rename or copy. */
  from?: string;
}

export interface BaseRef {
  /** `refs/remotes/origin/<branch>` or `refs/heads/<branch>`; null when neither exists. */
  ref: string | null;
  fetched: boolean;
  /** Why the fetch was skipped or failed, to log. */
  warning?: string;
}

const MAX_BUFFER = 10 * 1024 * 1024;
const STDERR_LENGTH = 4_096;
const FALLBACK_AUTHOR = 'algo-agent <algo-agent@localhost>';

/**
 * A remote URL with a user (or a token) in it, e.g. `https://u:p@host/r.git`
 * or `https://<token>@github.com/o/r`. SCP-like SSH (`git@host:o/r`) is fine:
 * it carries no secret.
 */
export function hasUserInfo(url: string) {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)/i.exec(url);
  if (!match) return false;
  const [, scheme, authority] = match;
  if (scheme.toLowerCase() === 'file') return false;
  return authority.includes('@');
}

/**
 * Every git command of the backend. Always `execFile` with an array, never a
 * shell, always with the repository hooks off: they would run code of the
 * worktree outside the sandbox.
 */
@Injectable()
export class GitService {
  constructor(private readonly config: ConfigService) {}

  /** 30 seconds by default, longer for the fetch. */
  private timeout(name: string, fallback: number) {
    const value = Number(this.config.get<string>(name));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private gitTimeout() {
    return this.timeout('MISSION_GIT_TIMEOUT_MS', 30_000);
  }

  private fetchTimeout() {
    return this.timeout('MISSION_GIT_FETCH_TIMEOUT_MS', 60_000);
  }

  private run(
    cwd: string,
    args: string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            ...env,
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const code =
              typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : null;
            reject(new GitError(args, code, stderr.slice(0, STDERR_LENGTH)));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  private async refExists(cwd: string, ref: string) {
    try {
      await this.run(
        cwd,
        ['rev-parse', '--verify', '--quiet', ref],
        this.gitTimeout(),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** The commit `ref` points to, or null. */
  async revParse(cwd: string, ref: string): Promise<string | null> {
    try {
      const out = await this.run(
        cwd,
        ['rev-parse', '--verify', '--quiet', ref],
        this.gitTimeout(),
      );
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  async isRepository(cwd: string) {
    try {
      const out = await this.run(
        cwd,
        ['rev-parse', '--is-inside-work-tree'],
        this.gitTimeout(),
      );
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Whether `branch` exists locally or as `origin/<branch>`. */
  async branchExists(cwd: string, branch: string) {
    if (await this.refExists(cwd, `refs/heads/${branch}`)) return true;
    return this.refExists(cwd, `refs/remotes/origin/${branch}`);
  }

  /** Whether `branch` is an acceptable name for `git branch`. */
  async checkRefFormat(cwd: string, branch: string) {
    try {
      await this.run(
        cwd,
        ['check-ref-format', '--branch', branch],
        this.gitTimeout(),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The branch a mission starts from: `develop` when it exists, otherwise the
   * remote's default branch, otherwise the current one. Null without git.
   */
  async resolveBaseBranch(cwd: string): Promise<string | null> {
    if (!(await this.isRepository(cwd))) return null;
    if (await this.branchExists(cwd, 'develop')) return 'develop';

    try {
      const head = (
        await this.run(
          cwd,
          ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
          this.gitTimeout(),
        )
      ).trim();
      if (head) return head.replace(/^origin\//, '');
    } catch {
      // No origin/HEAD: fall through to the current branch.
    }

    try {
      const current = (
        await this.run(
          cwd,
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          this.gitTimeout(),
        )
      ).trim();
      return current || null;
    } catch {
      return null;
    }
  }

  async hasOrigin(cwd: string) {
    try {
      const url = await this.run(
        cwd,
        ['remote', 'get-url', 'origin'],
        this.gitTimeout(),
      );
      return url.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** The origin URL, or null without one. */
  async remoteUrl(cwd: string): Promise<string | null> {
    try {
      const url = await this.run(
        cwd,
        ['remote', 'get-url', 'origin'],
        this.gitTimeout(),
      );
      return url.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Whether any remote URL embeds a user (or a token) before the host. The
   * URL is in the shared `.git/config`, which the sandbox lets agents read: a
   * token there would end up in the worktree, and then in the PR.
   */
  async remoteHasCredentials(cwd: string) {
    try {
      const out = await this.run(cwd, ['remote', '-v'], this.gitTimeout());
      return out
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((url): url is string => Boolean(url))
        .some(hasUserInfo);
    } catch {
      return false;
    }
  }

  /**
   * `origin/<branch>` when there is an `origin`, otherwise the local branch.
   * A failed fetch warns and keeps the remote ref if it's already here, then
   * falls back to the local one.
   */
  async baseRef(cwd: string, branch: string): Promise<BaseRef> {
    const local = `refs/heads/${branch}`;
    const remote = `refs/remotes/origin/${branch}`;

    if (!(await this.hasOrigin(cwd))) {
      if (await this.refExists(cwd, local)) {
        return { ref: local, fetched: false };
      }
      return { ref: null, fetched: false };
    }

    try {
      await this.run(cwd, ['fetch', 'origin', branch], this.fetchTimeout());
      if (await this.refExists(cwd, remote)) {
        return { ref: remote, fetched: true };
      }
      if (await this.refExists(cwd, local)) {
        return {
          ref: local,
          fetched: true,
          warning: `origin non ha "${branch}": uso il branch locale`,
        };
      }
      return { ref: null, fetched: true };
    } catch {
      if (await this.refExists(cwd, remote)) {
        return {
          ref: remote,
          fetched: false,
          warning: `Fetch da origin fallito: uso ${remote} già presente`,
        };
      }
      if (await this.refExists(cwd, local)) {
        return {
          ref: local,
          fetched: false,
          warning: `Fetch da origin fallito: uso il branch locale "${branch}"`,
        };
      }
      return { ref: null, fetched: false };
    }
  }

  /** Creates `name` at `startCommit`; an existing branch at the same commit is reused. */
  async createBranch(cwd: string, name: string, startCommit: string) {
    const current = await this.revParse(cwd, `refs/heads/${name}`);
    if (current) {
      if (current === startCommit) return;
      throw new GitError(
        ['branch', name, startCommit],
        null,
        `il branch ${name} esiste già e punta a ${current}`,
      );
    }
    await this.run(cwd, ['branch', name, startCommit], this.gitTimeout());
  }

  /** Moves an existing branch that has no work of its own. */
  async moveBranch(cwd: string, name: string, startCommit: string) {
    await this.run(cwd, ['branch', '-f', name, startCommit], this.gitTimeout());
  }

  /** How many commits `ref` has on top of `base`. */
  async aheadOfRef(cwd: string, ref: string, base: string) {
    const out = await this.run(
      cwd,
      ['rev-list', '--count', `${base}..${ref}`],
      this.gitTimeout(),
    );
    return Number(out.trim()) || 0;
  }

  async aheadOf(dir: string, base: string) {
    return this.aheadOfRef(dir, 'HEAD', base);
  }

  private async worktrees(cwd: string) {
    const out = await this.run(
      cwd,
      ['worktree', 'list', '--porcelain'],
      this.gitTimeout(),
    );
    const list: { path: string; branch: string | null }[] = [];
    let path: string | null = null;
    let branch: string | null = null;
    const flush = () => {
      if (path) list.push({ path, branch });
      path = null;
      branch = null;
    };
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        branch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (!line.trim()) {
        flush();
      }
    }
    flush();
    return list;
  }

  /** Adds a worktree for `branch`; an existing worktree of that branch is reused. */
  async addWorktree(cwd: string, dir: string, branch: string) {
    // macOS resolves /var to /private/var: compare what git printed with the
    // folder as the backend holds it, both through realpath.
    const real = async (path: string) => {
      try {
        return await realpath(path);
      } catch {
        return path;
      }
    };
    const target = await real(dir);
    let match: { path: string; branch: string | null } | null = null;
    for (const w of await this.worktrees(cwd)) {
      if ((await real(w.path)) === target) {
        match = w;
        break;
      }
    }
    if (match) {
      if (match.branch === branch) return;
      throw new GitError(
        ['worktree', 'add', dir, branch],
        null,
        `${dir} è già un worktree di ${match.branch ?? 'un altro branch'}`,
      );
    }
    if (existsSync(dir)) {
      throw new GitError(
        ['worktree', 'add', dir, branch],
        null,
        `la cartella ${dir} esiste già e non è un worktree`,
      );
    }
    await this.run(cwd, ['worktree', 'add', dir, branch], this.gitTimeout());
  }

  /** Removes a worktree and prunes the repository's records. */
  async removeWorktree(cwd: string, dir: string) {
    try {
      await this.run(
        cwd,
        ['worktree', 'remove', '--force', dir],
        this.gitTimeout(),
      );
    } catch {
      // Not a worktree (any more): the prune below is all that's left.
    }
    await this.run(cwd, ['worktree', 'prune'], this.gitTimeout()).catch(
      () => undefined,
    );
  }

  async deleteBranch(cwd: string, name: string) {
    try {
      await this.run(cwd, ['branch', '-D', name], this.gitTimeout());
    } catch {
      // Already gone.
    }
  }

  /** Puts a worktree back on `commit`, keeping its installed dependencies. */
  async resetTo(dir: string, commit: string) {
    await this.run(dir, ['reset', '--hard', commit], this.gitTimeout());
    await this.run(
      dir,
      ['clean', '-fdx', '-e', 'node_modules'],
      this.gitTimeout(),
    );
  }

  /** Changed files against `base`, untracked ones included. */
  async diff(dir: string, base: string): Promise<DiffEntry[]> {
    const tracked = await this.run(
      dir,
      ['diff', '--name-status', '-z', base],
      this.gitTimeout(),
    );
    const entries: DiffEntry[] = [];
    const parts = tracked.split('\0');
    let i = 0;
    while (i < parts.length) {
      const status = parts[i++];
      if (!status) continue;
      if (status.startsWith('R') || status.startsWith('C')) {
        const from = parts[i++];
        const file = parts[i++];
        if (file) entries.push({ status: status[0], file, from });
      } else {
        const file = parts[i++];
        if (file) entries.push({ status: status[0], file });
      }
    }

    const untracked = await this.run(
      dir,
      ['ls-files', '--others', '--exclude-standard', '-z'],
      this.gitTimeout(),
    );
    for (const file of untracked.split('\0')) {
      if (file) entries.push({ status: 'A', file });
    }
    return entries;
  }

  /** The files changed between two commits. */
  async changedBetween(cwd: string, from: string, to: string) {
    const out = await this.run(
      cwd,
      ['diff', '--name-only', '-z', from, to],
      this.gitTimeout(),
    );
    return out.split('\0').filter(Boolean);
  }

  /** A unified diff between two commits, or the worktree and `from`; capped. */
  async diffText(cwd: string, from: string, to?: string, maxBytes = 1_048_576) {
    const out = await this.run(
      cwd,
      ['diff', '--no-color', ...(to ? [from, to] : [from])],
      this.gitTimeout(),
    );
    return Buffer.byteLength(out) <= maxBytes
      ? out
      : Buffer.from(out).subarray(0, maxBytes).toString('utf8');
  }

  /** Added and removed lines per file against `base`. */
  async numstat(cwd: string, base: string) {
    const out = await this.run(
      cwd,
      ['diff', '--numstat', '-z', base],
      this.gitTimeout(),
    );
    const files = new Map<string, { added: number; removed: number }>();
    for (const part of out.split('\0')) {
      if (!part.trim()) continue;
      const [added, removed, file] = part.split('\t');
      if (!file) continue;
      files.set(file, {
        added: Number(added) || 0,
        removed: Number(removed) || 0,
      });
    }
    return files;
  }

  /** Moves the branch back to `commit`, keeping the worktree's files staged. */
  async resetSoft(dir: string, commit: string) {
    await this.run(dir, ['reset', '--soft', commit], this.gitTimeout());
  }

  /** A file as it was at `rev`; null when it didn't exist. */
  async showFile(
    dir: string,
    rev: string,
    path: string,
  ): Promise<string | null> {
    try {
      return await this.run(dir, ['show', `${rev}:${path}`], this.gitTimeout());
    } catch {
      return null;
    }
  }

  /** The `.git` folder shared by the project and its worktrees. */
  async commonGitDir(dir: string): Promise<string | null> {
    try {
      const out = (
        await this.run(
          dir,
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          this.gitTimeout(),
        )
      ).trim();
      if (out) return out;
    } catch {
      // Older git: no --path-format.
    }
    try {
      const out = (
        await this.run(
          dir,
          ['rev-parse', '--git-common-dir'],
          this.gitTimeout(),
        )
      ).trim();
      if (!out) return null;
      return isAbsolute(out) ? out : join(dir, out);
    } catch {
      return null;
    }
  }

  /** Author and committer for `dir`: its `user.*` config, or a fixed fallback. */
  private async authorEnv(dir: string): Promise<NodeJS.ProcessEnv> {
    const read = async (key: string) => {
      try {
        const value = (
          await this.run(dir, ['config', key], this.gitTimeout())
        ).trim();
        return value || null;
      } catch {
        return null;
      }
    };
    const name = (await read('user.name')) ?? FALLBACK_AUTHOR.split(' <')[0];
    const email =
      (await read('user.email')) ??
      FALLBACK_AUTHOR.slice(FALLBACK_AUTHOR.indexOf('<') + 1, -1);
    return {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
  }

  /**
   * Stages everything and commits it with the given trailers, e.g.
   * `{ Mission: '7', Task: 'login' }`. False when there was nothing to commit.
   */
  async commitAll(
    dir: string,
    message: string,
    trailers: Record<string, string> = {},
  ) {
    await this.run(dir, ['add', '-A'], this.gitTimeout());
    const staged = await this.run(
      dir,
      ['diff', '--cached', '--name-only'],
      this.gitTimeout(),
    );
    if (!staged.trim()) return false;
    const args = ['commit', '-m', message];
    for (const [key, value] of Object.entries(trailers)) {
      args.push('--trailer', `${key}: ${value}`);
    }
    await this.run(dir, args, this.gitTimeout(), await this.authorEnv(dir));
    return true;
  }

  /** `merge --no-ff`; a conflict throws, and `conflicts` lists the files. */
  async merge(dir: string, branch: string, message?: string) {
    await this.run(
      dir,
      message
        ? ['merge', '--no-ff', '-m', message, branch]
        : ['merge', '--no-ff', '--no-edit', branch],
      this.gitTimeout(),
    );
  }

  async abortMerge(dir: string) {
    await this.run(dir, ['merge', '--abort'], this.gitTimeout()).catch(
      () => undefined,
    );
  }

  /** Stages everything, as the integrator does after resolving a conflict. */
  async stageAll(dir: string) {
    await this.run(dir, ['add', '-A'], this.gitTimeout());
  }

  /** Concludes an open merge with its prepared message, with the project's author. */
  async continueMerge(dir: string) {
    await this.run(
      dir,
      ['commit', '--no-edit'],
      this.gitTimeout(),
      await this.authorEnv(dir),
    );
  }

  /** Which of `files` still carry conflict markers. */
  async conflictMarkers(dir: string, files: string[]) {
    const marked: string[] = [];
    for (const file of files) {
      const text = await readFile(join(dir, file), 'utf8').catch(() => '');
      if (/^<{7}|^={7}|^>{7}/m.test(text)) marked.push(file);
    }
    return marked;
  }

  async conflicts(dir: string) {
    const out = await this.run(
      dir,
      ['diff', '--name-only', '--diff-filter=U'],
      this.gitTimeout(),
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Creates a repository at `dir` on `branch`. */
  async initRepo(dir: string, branch: string) {
    await this.run(dir, ['init', '-b', branch], this.gitTimeout());
  }

  /** The initial empty commit of a new repository. */
  async commitEmpty(dir: string, message: string) {
    await this.run(
      dir,
      ['commit', '--allow-empty', '-m', message],
      this.gitTimeout(),
      await this.authorEnv(dir),
    );
  }

  async addRemote(dir: string, name: string, url: string) {
    await this.run(dir, ['remote', 'add', name, url], this.gitTimeout());
  }

  /** How many commits `rev` has. */
  async commitCount(dir: string, rev: string) {
    const out = await this.run(
      dir,
      ['rev-list', '--count', rev],
      this.gitTimeout(),
    );
    return Number(out.trim()) || 0;
  }

  /** The git directory of a worktree, for the sandbox profile. */
  async gitDirFor(cwd: string) {
    const dir = await this.commonGitDir(cwd);
    return dir ?? dirname(join(cwd, '.git'));
  }

  /**
   * §6.2: pushes `branch` to the https remote with the token in an
   * `http.extraHeader` from the environment: arguments show in the process
   * list, the environment doesn't. Errors are cleaned of the token.
   */
  async push(
    dir: string,
    remoteHttpsUrl: string,
    branch: string,
    auth: { kind: 'github' | 'gitlab'; token: string },
  ) {
    const user = auth.kind === 'github' ? 'x-access-token' : 'oauth2';
    const basic = Buffer.from(`${user}:${auth.token}`).toString('base64');
    const env = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    };
    try {
      await this.run(
        dir,
        ['push', remoteHttpsUrl, `refs/heads/${branch}:refs/heads/${branch}`],
        this.fetchTimeout(),
        env,
      );
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const clean = (value: string) =>
        value
          .split(auth.token)
          .join('***')
          .split(basic)
          .join('***')
          .split(encodeURIComponent(auth.token))
          .join('***');
      throw new GitError(error.args, error.code, clean(error.stderr));
    }
  }
}
