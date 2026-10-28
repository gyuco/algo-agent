import { join } from 'node:path';
import { buildCatalog, readCatalogDir, type CatalogEntry } from './catalog.js';

const agent = (
  key: string,
  spec: Record<string, unknown> = {},
): CatalogEntry => ({
  kind: 'agent',
  key,
  spec: { description: 'x', prompt: 'P', ...spec },
});

describe('readCatalogDir + buildCatalog', () => {
  it('loads the examples shipped with the app', async () => {
    const catalog = buildCatalog(
      await readCatalogDir(join(process.cwd(), 'catalog')),
    );
    expect(catalog.agents.get('assistant')?.permissions.files).toBe('write');
    expect(catalog.agents.get('reviewer')?.permissions.files).toBe('read');
    expect(catalog.skills.get('code-review')?.content).toContain(
      '# Code review',
    );
    expect(catalog.workflows.get('review-and-fix')?.steps).toHaveLength(3);
  });
});

describe('buildCatalog', () => {
  it('defaults an agent to no permissions at all', () => {
    const catalog = buildCatalog([agent('quiet')]);
    expect(catalog.agents.get('quiet')?.permissions).toEqual({
      files: 'none',
      tools: [],
      mcp: [],
      skills: [],
    });
  });

  it.each<[string, CatalogEntry[]]>([
    [
      'unknown permission fields',
      [agent('a', { permissions: { shell: true } })],
    ],
    ['unknown file access', [agent('a', { permissions: { files: 'all' } })]],
    [
      'MCP servers missing from the catalog',
      [agent('a', { permissions: { mcp: ['nope'] } })],
    ],
    [
      'app tools that do not exist',
      [agent('a', { permissions: { tools: ['nope'] } })],
    ],
    ['agents without a prompt', [agent('a', { prompt: '  ' })]],
    [
      'workflows with unknown agents',
      [
        {
          kind: 'workflow',
          key: 'w',
          spec: { description: 'x', steps: [{ agent: 'ghost', prompt: 'hi' }] },
        },
      ],
    ],
    [
      'workflows whose steps form a cycle',
      [
        agent('a'),
        {
          kind: 'workflow',
          key: 'w',
          spec: {
            description: 'x',
            steps: [
              { id: 'x', agent: 'a', prompt: 'hi', needs: ['y'] },
              { id: 'y', agent: 'a', prompt: 'hi', needs: ['x'] },
            ],
          },
        },
      ],
    ],
    [
      'workflow step ids that are not keys',
      [
        agent('a'),
        {
          kind: 'workflow',
          key: 'w',
          spec: {
            description: 'x',
            steps: [{ id: 'Review', agent: 'a', prompt: 'hi' }],
          },
        },
      ],
    ],
    [
      'the reserved app MCP name',
      [
        {
          kind: 'mcp',
          key: 'app',
          spec: { description: 'x', type: 'http', url: 'https://x.dev' },
        },
      ],
    ],
    [
      'non-http MCP URLs',
      [
        {
          kind: 'mcp',
          key: 'm',
          spec: { description: 'x', type: 'http', url: 'file:///etc/passwd' },
        },
      ],
    ],
    ['invalid keys', [agent('Bad_Name')]],
    ['duplicates', [agent('a'), agent('a')]],
  ])('rejects %s', (_, entries) => {
    expect(() => buildCatalog(entries)).toThrow();
  });
});
