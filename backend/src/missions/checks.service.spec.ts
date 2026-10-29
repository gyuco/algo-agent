import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChecksService,
  failureDetail,
  type CheckEvent,
  type CheckName,
} from './checks.service.js';
import { GitService } from './git-service.js';
import { planSchema, type Plan } from './plan-schema.js';
import { Sandbox, type SandboxCommand, type SandboxSpec } from './sandbox.js';
import { RunConfig } from '../runs/run-config.js';

/** Wraps nothing: it records what the checks ask the sandbox for. */
class FakeSandbox extends Sandbox {
  readonly specs: SandboxSpec[] = [];
  readonly commands: string[][] = [];

  async available() {
    return { available: true };
  }

  wrap(argv: string[], spec: SandboxSpec): SandboxCommand {
    this.specs.push(spec);
    this.commands.push(argv);
    return { command: argv[0], args: argv.slice(1) };
  }
}

const settings = (overrides: Record<string, string> = {}) =>
  new RunConfig({
    get: (name: string) =>
      ({
        DATA_DIR: dataDir(),
        MISSION_CHECK_TIMEOUT_MS: '10000',
        MISSION_CHECK_OUTPUT_KB: '64',
        ...overrides,
      })[name],
  } as never);

let root = '';
const dataDir = () => join(root, 'data');

function service(overrides: Record<string, string> = {}) {
  const sandbox = new FakeSandbox();
  const checks = new ChecksService(
    settings(overrides),
    sandbox,
    new GitService({ get: () => undefined } as never),
    { project: { findMany: async () => [] } } as never,
  );
  return { checks, sandbox };
}

function plan(overrides: Record<string, unknown> = {}): Plan {
  return planSchema.parse({
    title: 'Login',
    goal: 'g',
    checks: { test: 'node -e "0"' },
    team: {
      orchestrator: 'claude:opus',
      roles: { integrator: { agent: 'assistant', model: 'claude:sonnet' } },
    },
    milestones: [{ id: 'm', tasks: [{ key: 't', acceptance: ['ok'] }] }],
    ...overrides,
  });
}

function request(overrides: Partial<Parameters<ChecksService['run']>[0]> = {}) {
  const controller = new AbortController();
  return {
    projectId: 1,
    worktree: root,
    plan: plan(),
    names: ['test'] as CheckName[],
    secrets: {},
    signal: controller.signal,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'algo-checks-'));
  await mkdir(dataDir(), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ChecksService', () => {
  it('runs without a shell: the text of an argument stays literal', async () => {
    const { checks, sandbox } = service();
    const result = await checks.run(
      request({
        plan: plan({
          checks: {
            test: `node -e "process.stdout.write(process.argv[1])" '$HOME && x'`,
          },
        }),
        names: ['test'],
      }),
    );
    expect(result[0].ok).toBe(true);
    expect(result[0].output).toContain('$HOME && x');
    expect(sandbox.commands[0][0]).toBe('node');
  });

  it('keeps the tail of the output', async () => {
    const { checks } = service({ MISSION_CHECK_OUTPUT_KB: '1' });
    const result = await checks.run(
      request({
        plan: plan({
          checks: {
            test: `node -e "process.stdout.write('a'.repeat(5000) + 'END')"`,
          },
        }),
      }),
    );
    expect(result[0].ok).toBe(true);
    expect(result[0].output.length).toBeLessThanOrEqual(1024);
    expect(result[0].output.endsWith('END')).toBe(true);
  });

  it('stops at the first command that fails', async () => {
    const { checks } = service();
    const result = await checks.run(
      request({
        plan: plan({
          checks: {
            build: `node -e "process.exit(2)"`,
            test: `node -e "0"`,
          },
        }),
        names: ['build', 'test'],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'build', ok: false, exitCode: 2 });
  });

  it('kills the whole group on timeout', async () => {
    const { checks } = service({ MISSION_CHECK_TIMEOUT_MS: '300' });
    const marker = join(root, 'grandchild.txt');
    await writeFile(
      join(root, 'timeout.js'),
      `const marker = ${JSON.stringify(marker)}
const { spawn } = require('child_process')
spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], 'x'), 1500)", marker])
setInterval(() => {}, 500)
`,
    );
    const result = await checks.run(
      request({ plan: plan({ checks: { test: 'node timeout.js' } }) }),
    );
    expect(result[0].timedOut).toBe(true);
    expect(result[0].ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('has only the minimal environment, with a fake HOME', async () => {
    const { checks } = service();
    process.env.MISSION_TEST_LEAK = 'leak';
    const result = await checks.run(
      request({
        plan: plan({
          checks: {
            test: `node -e "process.stdout.write(JSON.stringify({home:process.env.HOME,ci:process.env.CI,leak:process.env.MISSION_TEST_LEAK??null,cache:process.env.npm_config_cache}))"`,
          },
        }),
      }),
    );
    delete process.env.MISSION_TEST_LEAK;
    const printed = JSON.parse(result[0].output) as Record<
      string,
      string | null
    >;
    expect(printed.ci).toBe('1');
    expect(printed.leak).toBeNull();
    expect(printed.home).toContain('sandbox-tmp');
    expect(printed.cache).toContain('sandbox-cache');
  });

  it('passes the secrets in the environment and masks them in the output', async () => {
    const { checks, sandbox } = service();
    const result = await checks.run(
      request({
        plan: plan({
          checks: { test: `node -e "process.stdout.write(process.env.TOKEN)"` },
        }),
        secrets: { TOKEN: 'super-segreto' },
      }),
    );
    expect(result[0].ok).toBe(true);
    expect(result[0].output).toBe('***');
    expect(JSON.stringify(sandbox.commands)).not.toContain('super-segreto');
  });

  it('masks a secret split across two chunks in the live output too', async () => {
    const { checks } = service();
    const live: string[] = [];
    const script =
      "process.stdout.write('xx super-'); setTimeout(() => process.stdout.write('segreto yy'), 50)";
    const result = await checks.run(
      request({
        plan: plan({ checks: { test: `node -e "${script}"` } }),
        secrets: { TOKEN: 'super-segreto' },
        onEvent: (e) => {
          if (e.type === 'output') live.push(e.text);
        },
      }),
    );
    expect(result[0].output).toBe('xx *** yy');
    expect(live.join('')).toBe('xx *** yy');
    expect(live.join('')).not.toContain('segreto');
  });

  it("doesn't let a secret replace PATH or HOME", async () => {
    const { checks } = service();
    const result = await checks.run(
      request({
        plan: plan({
          checks: { test: `node -e "process.stdout.write(process.env.HOME)"` },
        }),
        secrets: { HOME: '/tmp/altrove' },
      }),
    );
    expect(result[0].output).toContain('sandbox-tmp');
  });

  it('runs setup once per worktree, and again when a lockfile changes', async () => {
    const { checks } = service();
    const req = request({
      plan: plan({
        checks: {
          setup: `node -e "require('fs').appendFileSync('setup.log','x')"`,
          test: 'node -e "0"',
        },
      }),
    });
    await checks.ensureSetup(req);
    await checks.ensureSetup(req);
    expect(await readFile(join(root, 'setup.log'), 'utf8')).toBe('x');

    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    await checks.ensureSetup(req);
    expect(await readFile(join(root, 'setup.log'), 'utf8')).toBe('xx');
  });

  it('adds --ignore-scripts only to installs with new dependencies in scope', async () => {
    // A stand-in for npm on PATH: the test is about the arguments, not the install.
    const bin = join(root, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const { checks, sandbox } = service();
      await checks.run(
        request({
          plan: plan({
            checks: { setup: 'npm ci', test: 'node -e "0"' },
            scope: { dependencies: ['x'] },
          }),
          names: ['setup'],
        }),
      );
      expect(sandbox.commands[0]).toContain('--ignore-scripts');

      const second = service();
      await second.checks.run(
        request({
          plan: plan({ checks: { setup: 'npm ci', test: 'node -e "0"' } }),
          names: ['setup'],
        }),
      );
      expect(second.sandbox.commands[0]).not.toContain('--ignore-scripts');
    } finally {
      process.env.PATH = path;
    }
  });

  it('runs in the command workdir, inside the worktree', async () => {
    const { checks } = service();
    await mkdir(join(root, 'backend'));
    const result = await checks.run(
      request({
        plan: plan({
          checks: {
            test: `node -e "process.stdout.write(process.cwd())"`,
            workdir: 'backend',
          },
        }),
      }),
    );
    expect(result[0].ok).toBe(true);
    expect(result[0].output.endsWith('/backend')).toBe(true);
  });

  it('keeps two checks off the same project when parallel is false', async () => {
    const { checks } = service();
    const log = join(root, 'lock.log');
    const script = `node -e "const fs=require('fs');fs.appendFileSync('${log}','start;');setTimeout(()=>fs.appendFileSync('${log}','end;'),250)"`;
    const worktreeB = join(root, 'b');
    await mkdir(worktreeB);

    const events: CheckEvent[] = [];
    const first = checks.run(
      request({
        plan: plan({ checks: { test: script, parallel: false } }),
        onEvent: (e) => events.push(e),
      }),
    );
    const second = checks.run(
      request({
        worktree: worktreeB,
        plan: plan({ checks: { test: script, parallel: false } }),
      }),
    );
    await Promise.all([first, second]);
    expect(await readFile(log, 'utf8')).toBe('start;end;start;end;');
  });

  it('lets two worktrees of a project run together when parallel is true', async () => {
    const { checks } = service();
    const log = join(root, 'lock.log');
    const script = `node -e "const fs=require('fs');fs.appendFileSync('${log}','start;');setTimeout(()=>fs.appendFileSync('${log}','end;'),250)"`;
    const worktreeB = join(root, 'b');
    await mkdir(worktreeB);

    const first = checks.run(
      request({ plan: plan({ checks: { test: script, parallel: true } }) }),
    );
    const second = checks.run(
      request({
        worktree: worktreeB,
        plan: plan({ checks: { test: script, parallel: true } }),
      }),
    );
    await Promise.all([first, second]);
    expect(await readFile(log, 'utf8')).toBe('start;start;end;end;');
  });
});

describe('failureDetail', () => {
  const result = (output: string) => ({
    name: 'test' as const,
    argv: [],
    ok: false,
    exitCode: 1,
    timedOut: false,
    durationMs: 0,
    output,
  });

  it('starts at the error report, not at the banner', () => {
    const output = [
      '> pkg@0.1.0 test',
      '> vitest run',
      '==========',
      'WARNING: package renamed',
      ' \x1b[32m✓\x1b[39m passes',
      '\x1b[41m FAIL \x1b[49m test/a.test.ts > slow case',
      '\x1b[31mError\x1b[22m: Test timed out in 5000ms.',
    ].join('\n');
    expect(failureDetail(result(output))).toBe(
      'FAIL  test/a.test.ts > slow case\nError: Test timed out in 5000ms.',
    );
  });

  it('falls back to the start of the output', () => {
    expect(failureDetail(result('one\ntwo'))).toBe('one\ntwo');
  });
});
