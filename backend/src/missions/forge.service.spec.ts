import { detect, ForgeError, ForgeService, httpsUrl } from './forge.service.js';

const service = new ForgeService();

describe('forge detection', () => {
  it('converts SSH and HTTPS remotes to the https URL', () => {
    expect(httpsUrl('git@github.com:o/r.git')).toBe('https://github.com/o/r.git');
    expect(httpsUrl('ssh://git@gitlab.example.com/ns/r.git')).toBe(
      'https://gitlab.example.com/ns/r.git',
    );
    expect(httpsUrl('https://github.com/o/r.git')).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('detects github, gitlab, self-hosted and unknown forges', () => {
    expect(detect('git@github.com:o/r.git')).toMatchObject({
      kind: 'github',
      apiBase: 'https://api.github.com',
      owner: 'o',
      repo: 'r',
    });
    expect(detect('https://gitlab.com/ns/sub/r.git')).toMatchObject({
      kind: 'gitlab',
      owner: 'ns/sub',
      repo: 'r',
    });
    expect(
      detect('https://git.example.com/ns/r.git', 'https://git.example.com'),
    ).toMatchObject({
      kind: 'gitlab',
      apiBase: 'https://git.example.com/api/v4',
    });
    expect(detect('https://bitbucket.org/o/r.git')).toBeNull();
    expect(detect('not a url')).toBeNull();
  });
});

describe('forge pulls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const forge = detect('git@github.com:o/r.git')!;

  it('reuses an open pull request', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => [{ html_url: 'https://github.com/o/r/pull/3', number: 3 }],
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(service.findOpenPr(forge, 't', 'mission/1', 'main')).resolves.toEqual({
      url: 'https://github.com/o/r/pull/3',
      number: 3,
    });
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain(
      'head=o%3Amission%2F1',
    );
  });

  it('creates a pull request', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ html_url: 'https://github.com/o/r/pull/4', number: 4 }),
    }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      service.createPr(forge, 't', {
        head: 'mission/1',
        base: 'main',
        title: 'Mission',
        body: 'body',
      }),
    ).resolves.toEqual({ url: 'https://github.com/o/r/pull/4', number: 4 });
  });

  it('maps every error to its text', async () => {
    for (const [status, text] of [
      [401, /token non valido/],
      [404, /repository non trovato/],
      [422, /la PR esiste già/],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status,
          text: async () => '',
        })),
      );
      await expect(
        service.findOpenPr(forge, 't', 'b', 'main'),
      ).rejects.toMatchObject({ status });
      await expect(
        service.findOpenPr(forge, 't', 'b', 'main'),
      ).rejects.toThrow(text);
      await expect(
        service.findOpenPr(forge, 't', 'b', 'main'),
      ).rejects.toBeInstanceOf(ForgeError);
    }
  });
});
