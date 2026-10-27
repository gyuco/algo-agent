import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localConfig,
  mcpServer,
  runConfig,
  stripJsonc,
} from './opencode-config.js';

describe('stripJsonc', () => {
  it('drops comments and trailing commas but not string content', () => {
    const source = `{
      // comment
      "url": "http://x//y", /* block */
      "list": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonc(source))).toEqual({
      url: 'http://x//y',
      list: [1, 2],
    });
  });

  it('keeps escaped quotes inside strings', () => {
    expect(JSON.parse(stripJsonc('{"a": "say \\"hi\\" // no"}'))).toEqual({
      a: 'say "hi" // no',
    });
  });
});

describe('localConfig', () => {
  it('keeps only providers and the default model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-config-'));
    await writeFile(
      join(dir, 'opencode.json'),
      JSON.stringify({
        model: 'ollama/qwen',
        providers: { ollama: { name: 'Ollama' } },
        mcp: { servers: { x: { type: 'local', command: ['x'] } } },
        plugins: ['p'],
        agents: { build: {} },
      }),
    );
    expect(await localConfig(dir)).toEqual({
      model: 'ollama/qwen',
      providers: { ollama: { name: 'Ollama' } },
    });
  });

  it('is empty without a config', async () => {
    expect(
      await localConfig(await mkdtemp(join(tmpdir(), 'oc-none-'))),
    ).toEqual({});
  });
});

describe('runConfig', () => {
  it('adds the app agent as the default one', () => {
    const config = runConfig(
      { model: 'a/b' },
      { system: 'S', steps: 5, permissions: [] },
    );
    expect(config).toEqual({
      model: 'a/b',
      default_agent: 'app',
      agents: {
        app: { mode: 'primary', system: 'S', steps: 5, permissions: [] },
      },
    });
  });
});

describe('runConfig subagents', () => {
  it('adds the subagents next to the app agent', () => {
    const config = runConfig(
      {},
      { system: 'S', steps: 5, permissions: [] },
      {},
      {
        agent_reviewer: {
          description: 'D',
          system: 'R',
          steps: 3,
          permissions: [],
          model: 'p/m',
        },
      },
    );
    expect(config.agents).toEqual({
      app: { mode: 'primary', system: 'S', steps: 5, permissions: [] },
      agent_reviewer: {
        mode: 'subagent',
        description: 'D',
        system: 'R',
        steps: 3,
        permissions: [],
        model: 'p/m',
      },
    });
  });
});

describe('mcpServer', () => {
  it('maps stdio and http servers, with ${VAR} filled in', () => {
    process.env.OC_TEST_TOKEN = 'secret';
    expect(
      mcpServer({
        key: 'local',
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'srv'],
        env: { TOKEN: '${OC_TEST_TOKEN}' },
      } as never),
    ).toEqual({
      type: 'local',
      command: ['npx', '-y', 'srv'],
      environment: { TOKEN: 'secret' },
      codemode: false,
    });
    expect(
      mcpServer({
        key: 'docs',
        type: 'http',
        url: 'https://x/mcp',
        headers: { Authorization: 'Bearer ${OC_TEST_TOKEN}' },
      } as never),
    ).toEqual({
      type: 'remote',
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer secret' },
      oauth: false,
      codemode: false,
    });
  });

  it('adds MCP servers to the run config only when there are some', () => {
    expect(runConfig({}, undefined, {})).toEqual({});
    expect(runConfig({}, undefined, { a: { type: 'remote' } })).toEqual({
      mcp: { servers: { a: { type: 'remote' } } },
    });
  });
});
