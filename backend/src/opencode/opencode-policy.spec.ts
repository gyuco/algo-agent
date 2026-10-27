import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentPolicy } from '../agents/policy.js';
import {
  delegationViolation,
  permissionRules,
  permissionViolation,
  type PermissionRequest,
} from './opencode-policy.js';

const policy = (
  files: AgentPolicy['files'],
  over: Partial<AgentPolicy> = {},
): AgentPolicy => ({ files, tools: [], mcp: [], skills: [], ...over });

const request = (
  action: string,
  resources: string[],
  metadata?: PermissionRequest['metadata'],
): PermissionRequest => ({ id: 'per_1', action, resources, metadata });

describe('permissionRules', () => {
  it('denies everything first, then asks for the granted file actions', () => {
    expect(permissionRules(policy('none'))).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
    ]);
    expect(permissionRules(policy('read')).map((r) => r.action)).toEqual([
      '*',
      'read',
      'glob',
      'grep',
    ]);
    expect(permissionRules(policy('write')).at(-1)).toEqual({
      action: 'edit',
      resource: '*',
      effect: 'ask',
    });
  });

  it('asks for granted app tools, MCP servers and skills', () => {
    const rules = permissionRules(
      policy('none', { tools: ['t'], mcp: ['docs', 'gh'], skills: ['s'] }),
    );
    expect(rules.map((r) => r.action)).toEqual([
      '*',
      'app_*',
      'mcp-docs_*',
      'mcp-gh_*',
      'skill',
    ]);
  });
});

describe('permissionViolation', () => {
  let cwd: string;
  let outside: string;

  beforeAll(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'oc-cwd-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'oc-other-')));
    await writeFile(join(cwd, 'a.txt'), 'x');
    await writeFile(join(outside, 'secret.txt'), 'x');
    await symlink(join(outside, 'secret.txt'), join(cwd, 'link.txt'));
  });

  it.each([
    ['read', ['a.txt'], undefined],
    ['glob', ['**/*.txt'], { root: '.' }],
    ['grep', ['secret'], { root: '.', path: '.' }],
  ])('allows %s inside the project', async (action, resources, metadata) => {
    expect(
      await permissionViolation(
        cwd,
        policy('read'),
        request(action, resources, metadata),
      ),
    ).toBeNull();
  });

  it('allows edits only with write access', async () => {
    const edit = request('edit', ['new.txt']);
    expect(await permissionViolation(cwd, policy('write'), edit)).toBeNull();
    expect(await permissionViolation(cwd, policy('read'), edit)).toMatch(
      /solo leggere/,
    );
  });

  it.each([
    ['read', ['link.txt'], undefined],
    ['read', ['../x'], undefined],
    ['glob', ['/etc/*'], { root: '.' }],
    ['grep', ['root'], { root: '.', path: '/etc' }],
  ])(
    'rejects %s %j reaching outside the project',
    async (action, resources, metadata) => {
      expect(
        await permissionViolation(
          cwd,
          policy('write'),
          request(action, resources, metadata),
        ),
      ).toMatch(/cartella di lavoro/);
    },
  );

  it('allows only the granted app tools, MCP servers and skills', async () => {
    const granted = policy('none', {
      tools: ['current_datetime'],
      mcp: ['docs'],
      skills: ['review'],
    });
    const check = (action: string, resources = ['*']) =>
      permissionViolation(cwd, granted, request(action, resources));
    expect(await check('app_current_datetime')).toBeNull();
    expect(await check('app_other')).toMatch(/non è consentito/);
    expect(await check('mcp-docs_resolve_library_id')).toBeNull();
    expect(await check('mcp-gh_create_issue')).toMatch(/non è consentito/);
    expect(await check('skill', ['review'])).toBeNull();
    expect(await check('skill', ['opencode'])).toMatch(/non è consentita/);
  });

  it('never reads a built-in action as an MCP tool', async () => {
    const granted = policy('write', { mcp: ['external'] });
    expect(
      await permissionViolation(
        cwd,
        granted,
        request('external_directory', ['/etc']),
      ),
    ).toMatch(/non è consentito/);
  });

  it('rejects anything that is not a file action', async () => {
    expect(
      await permissionViolation(cwd, policy('write'), request('shell', ['ls'])),
    ).toMatch(/non è consentito/);
  });
});

describe('delegation', () => {
  it('offers only the named subagents, under their prefixed ids', () => {
    expect(permissionRules(policy('none'), ['reviewer']).at(-1)).toEqual({
      action: 'subagent',
      resource: 'agent_reviewer',
      effect: 'ask',
    });
  });

  it("lets only the main agent delegate, and only to the project's agents", () => {
    const ask = (resources: string[]) => request('subagent', resources);
    expect(
      delegationViolation(['reviewer'], false, ask(['agent_reviewer'])),
    ).toBeNull();
    expect(
      delegationViolation(['reviewer'], true, ask(['agent_reviewer'])),
    ).not.toBeNull();
    expect(
      delegationViolation(['reviewer'], false, ask(['general'])),
    ).not.toBeNull();
    expect(
      delegationViolation(['reviewer'], false, ask(['agent_coder'])),
    ).not.toBeNull();
    expect(delegationViolation(['reviewer'], false, ask([]))).not.toBeNull();
  });
});
