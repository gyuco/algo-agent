import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, GitService } from './git-service.js';

const service = new GitService({ get: () => undefined } as never);

async function fakeGit(stderr: string) {
  const dir = await mkdtemp(join(tmpdir(), 'algo-fake-git-'));
  const script = join(dir, 'git');
  await writeFile(
    script,
    `#!/bin/sh
printf '%s\\n' "$@" > "$ARGS_FILE"
printf '%s\\n' "$GIT_CONFIG_VALUE_0" > "$ENV_FILE"
echo "${stderr}" >&2
exit 1
`,
  );
  await chmod(script, 0o755);
  return { dir, script };
}

describe('GitService.push', () => {
  it('keeps the token out of the arguments and cleans it from the error', async () => {
    const token = 'supersecret';
    const { dir } = await fakeGit(`fatal: auth ${token} failed`);
    const argsFile = join(dir, 'args.txt');
    const envFile = join(dir, 'env.txt');
    const previous = { ...process.env };
    process.env.PATH = `${dir}:${previous.PATH}`;
    process.env.ARGS_FILE = argsFile;
    process.env.ENV_FILE = envFile;
    try {
      await expect(
        service.push('/repo', 'https://github.com/o/r.git', 'mission/7', {
          kind: 'github',
          token,
        }),
      ).rejects.toBeInstanceOf(GitError);
      const args = await readFile(argsFile, 'utf8');
      expect(args).not.toContain(token);
      expect(args).toContain('refs/heads/mission/7:refs/heads/mission/7');
      const header = (await readFile(envFile, 'utf8')).trim();
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      expect(header).toBe(`Authorization: Basic ${basic}`);
      expect(header).not.toContain(token);
    } finally {
      process.env = previous;
    }
  });

  it('uses oauth2 as the user for GitLab', async () => {
    const token = 'glpat-secret';
    const { dir } = await fakeGit('nope');
    const envFile = join(dir, 'env.txt');
    const previous = { ...process.env };
    process.env.PATH = `${dir}:${previous.PATH}`;
    process.env.ARGS_FILE = join(dir, 'args.txt');
    process.env.ENV_FILE = envFile;
    try {
      await service
        .push('/repo', 'https://gitlab.com/o/r.git', 'b', {
          kind: 'gitlab',
          token,
        })
        .catch(() => undefined);
      const basic = Buffer.from(`oauth2:${token}`).toString('base64');
      expect((await readFile(envFile, 'utf8')).trim()).toBe(
        `Authorization: Basic ${basic}`,
      );
    } finally {
      process.env = previous;
    }
  });
});
