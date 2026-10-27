import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinTools, toolCallViolation, type AgentPolicy } from './policy.js';

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  files: 'write',
  tools: [],
  mcp: [],
  skills: [],
  ...over,
});

describe('builtinTools', () => {
  it('maps file access to tools and never adds a shell', () => {
    expect(builtinTools(policy({ files: 'none' }))).toEqual([]);
    expect(builtinTools(policy({ files: 'read' }))).toEqual([
      'Read',
      'Glob',
      'Grep',
    ]);
    expect(builtinTools(policy({ skills: ['x'] }))).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Write',
      'Edit',
      'Skill',
    ]);
  });
});

describe('toolCallViolation', () => {
  let cwd: string;
  let outside: string;

  beforeAll(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'ws-cwd-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'ws-other-')));
    await writeFile(join(cwd, 'a.txt'), 'x');
    await writeFile(join(outside, 'secret.txt'), 'x');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'link.txt'));
    await symlink(outside, join(cwd, 'linkdir'));
  });

  it.each([
    ['Read', { file_path: 'a.txt' }],
    ['Read', { file_path: join('CWD', 'a.txt') }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Grep', { pattern: 'foo', path: 'src' }],
    ['Grep', { pattern: '/^import/' }],
    ['Write', { file_path: 'new/dir/file.txt', content: 'x' }],
    ['Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }],
  ])('allows %s %j inside the workspace', async (tool, input) => {
    const resolved = Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, v.replace('CWD', cwd)]),
    );
    await expect(
      toolCallViolation(cwd, policy(), tool, resolved),
    ).resolves.toBeNull();
  });

  it.each([
    ['Read', { file_path: '/etc/hosts' }],
    ['Read', { file_path: '../secret.txt' }],
    ['Read', { file_path: 'link.txt' }],
    ['Glob', { pattern: '/etc/**' }],
    ['Glob', { pattern: '*', path: '/etc' }],
    ['Grep', { pattern: 'root', path: '/etc' }],
    ['Bash', { command: 'ls' }],
    ['Agent', { prompt: 'x' }],
    ['Write', { file_path: '/tmp/out.txt', content: 'x' }],
    ['Write', { file_path: 'linkdir/new.txt', content: 'x' }],
    ['Write', { file_path: 'linkdir/sub/new.txt', content: 'x' }],
    ['Edit', { file_path: 'link.txt', old_string: 'x', new_string: 'y' }],
  ])('denies %s %j', async (tool, input) => {
    await expect(
      toolCallViolation(cwd, policy(), tool, input),
    ).resolves.toEqual(expect.any(String));
  });

  it('keeps read-only agents from writing', async () => {
    const readOnly = policy({ files: 'read' });
    await expect(
      toolCallViolation(cwd, readOnly, 'Read', { file_path: 'a.txt' }),
    ).resolves.toBeNull();
    for (const tool of ['Write', 'Edit']) {
      await expect(
        toolCallViolation(cwd, readOnly, tool, { file_path: 'a.txt' }),
      ).resolves.toEqual(expect.any(String));
    }
  });

  it('keeps agents without file access off the files', async () => {
    await expect(
      toolCallViolation(cwd, policy({ files: 'none' }), 'Read', {
        file_path: 'a.txt',
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it('allows only the app tools and MCP servers granted', async () => {
    const p = policy({ tools: ['current_datetime'], mcp: ['docs'] });
    await expect(
      toolCallViolation(cwd, p, 'mcp__app__current_datetime', {}),
    ).resolves.toBeNull();
    await expect(
      toolCallViolation(cwd, p, 'mcp__docs__search', {}),
    ).resolves.toBeNull();
    await expect(
      toolCallViolation(cwd, p, 'mcp__app__other', {}),
    ).resolves.toEqual(expect.any(String));
    await expect(
      toolCallViolation(cwd, p, 'mcp__github__create_issue', {}),
    ).resolves.toEqual(expect.any(String));
  });

  it('allows only the skills granted, plugin-qualified or not', async () => {
    const p = policy({ skills: ['code-review'] });
    for (const skill of ['code-review', 'catalog:code-review']) {
      await expect(
        toolCallViolation(cwd, p, 'Skill', { skill }),
      ).resolves.toBeNull();
    }
    for (const input of [{ skill: 'catalog:other' }, {}]) {
      await expect(toolCallViolation(cwd, p, 'Skill', input)).resolves.toEqual(
        expect.any(String),
      );
    }
  });
});
