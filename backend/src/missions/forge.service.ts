import { Injectable } from '@nestjs/common';

export interface Forge {
  kind: 'github' | 'gitlab';
  /** github.com, gitlab.com or the host of GITLAB_URL. */
  host: string;
  apiBase: string;
  /** Namespace, which may hold subgroups on GitLab. */
  owner: string;
  repo: string;
}

export interface PullRequest {
  url: string;
  number: number;
}

/** A forge API error, with the text the user reads. */
export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

/** The user-facing text of an API error. */
function explain(status: number) {
  if (status === 401 || status === 403) {
    return 'token non valido o senza permessi';
  }
  if (status === 404) return 'repository non trovato o token senza accesso';
  if (status === 422) {
    return 'la PR esiste già o il branch non è stato pubblicato';
  }
  return `il forge ha risposto ${status}`;
}

/** `git@host:ns/repo.git` or `ssh://git@host/ns/repo.git` to `https://host/ns/repo.git`. */
export function httpsUrl(remoteUrl: string) {
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(remoteUrl);
  if (scp && !remoteUrl.includes('://')) {
    return `https://${scp[1]}/${scp[2].replace(/\.git$/, '')}.git`;
  }
  try {
    const url = new URL(remoteUrl);
    if (!['ssh:', 'git:', 'http:', 'https:'].includes(url.protocol)) return remoteUrl;
    return `https://${url.host}${url.pathname.replace(/\.git$/, '')}.git`;
  } catch {
    return remoteUrl;
  }
}

function split(remoteUrl: string) {
  const https = httpsUrl(remoteUrl);
  try {
    const url = new URL(https);
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    const parts = path.split('/');
    const repo = parts.pop();
    const owner = parts.join('/');
    if (!repo || !owner) return null;
    return { host: url.host, owner, repo };
  } catch {
    return null;
  }
}

/** `github.com`, `gitlab.com` or the host of `GITLAB_URL`. */
export function detect(remoteUrl: string, gitlabUrl?: string): Forge | null {
  const parts = split(remoteUrl);
  if (!parts) return null;
  if (parts.host === 'github.com' || parts.host === 'www.github.com') {
    return {
      kind: 'github',
      host: 'github.com',
      apiBase: 'https://api.github.com',
      owner: parts.owner,
      repo: parts.repo,
    };
  }
  const selfHosted = gitlabUrl ? new URL(gitlabUrl).host : null;
  if (parts.host === 'gitlab.com' || parts.host === selfHosted) {
    const base = gitlabUrl?.replace(/\/+$/, '') ?? 'https://gitlab.com';
    return {
      kind: 'gitlab',
      host: parts.host,
      apiBase: `${base}/api/v4`,
      owner: parts.owner,
      repo: parts.repo,
    };
  }
  return null;
}

@Injectable()
export class ForgeService {
  private headers(forge: Forge, token: string): Record<string, string> {
    return forge.kind === 'github'
      ? {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }
      : { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
  }

  private async call<T>(
    forge: Forge,
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const response = await fetch(`${forge.apiBase}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...this.headers(forge, token),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ForgeError(
        response.status,
        `${explain(response.status)}${text ? `: ${text.slice(0, 300)}` : ''}`,
      );
    }
    return (await response.json()) as T;
  }

  /** The open pull request (or merge request) of that branch pair, if any. */
  async findOpenPr(
    forge: Forge,
    token: string,
    head: string,
    base: string,
  ): Promise<PullRequest | null> {
    if (forge.kind === 'github') {
      const list = await this.call<
        { html_url: string; number: number }[]
      >(
        forge,
        token,
        `/repos/${forge.owner}/${forge.repo}/pulls?head=${encodeURIComponent(`${forge.owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
      );
      const found = list[0];
      return found ? { url: found.html_url, number: found.number } : null;
    }
    const project = encodeURIComponent(`${forge.owner}/${forge.repo}`);
    const list = await this.call<{ web_url: string; iid: number }[]>(
      forge,
      token,
      `/projects/${project}/merge_requests?source_branch=${encodeURIComponent(head)}&target_branch=${encodeURIComponent(base)}&state=opened`,
    );
    const found = list[0];
    return found ? { url: found.web_url, number: found.iid } : null;
  }

  async createPr(
    forge: Forge,
    token: string,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequest> {
    if (forge.kind === 'github') {
      const created = await this.call<{ html_url: string; number: number }>(
        forge,
        token,
        `/repos/${forge.owner}/${forge.repo}/pulls`,
        {
          method: 'POST',
          body: {
            title: input.title,
            head: input.head,
            base: input.base,
            body: input.body,
          },
        },
      );
      return { url: created.html_url, number: created.number };
    }
    const project = encodeURIComponent(`${forge.owner}/${forge.repo}`);
    const created = await this.call<{ web_url: string; iid: number }>(
      forge,
      token,
      `/projects/${project}/merge_requests`,
      {
        method: 'POST',
        body: {
          source_branch: input.head,
          target_branch: input.base,
          title: input.title,
          description: input.body,
        },
      },
    );
    return { url: created.web_url, number: created.iid };
  }

  /** §8.3: creates the remote repository, empty, and returns its URL and default branch. */
  async createRepo(
    kind: 'github' | 'gitlab',
    token: string,
    input: {
      name: string;
      namespace?: string;
      visibility: 'private' | 'internal' | 'public';
      apiBase?: string;
    },
  ): Promise<{ httpsUrl: string; defaultBranch: string }> {
    const apiBase =
      input.apiBase ??
      (kind === 'github' ? 'https://api.github.com' : 'https://gitlab.com/api/v4');
    const forge: Forge = {
      kind,
      host: new URL(apiBase).host,
      apiBase,
      owner: input.namespace ?? '',
      repo: input.name,
    };
    if (kind === 'github') {
      const path = input.namespace
        ? `/orgs/${input.namespace}/repos`
        : '/user/repos';
      const created = await this.call<{
        html_url: string;
        default_branch: string;
      }>(forge, token, path, {
        method: 'POST',
        body: {
          name: input.name,
          private: input.visibility !== 'public',
          ...(input.visibility === 'internal' ? { visibility: 'internal' } : {}),
        },
      });
      return {
        httpsUrl: `${created.html_url}.git`,
        defaultBranch: created.default_branch || 'main',
      };
    }
    let namespaceId: number | undefined;
    if (input.namespace) {
      const found = await this.call<{ id: number; full_path: string }[]>(
        forge,
        token,
        `/namespaces?search=${encodeURIComponent(input.namespace)}`,
      );
      namespaceId = found.find((n) => n.full_path === input.namespace)?.id;
      if (!namespaceId) {
        throw new ForgeError(404, `namespace ${input.namespace} non trovato`);
      }
    }
    const created = await this.call<{
      web_url: string;
      default_branch: string | null;
    }>(forge, token, '/projects', {
      method: 'POST',
      body: {
        name: input.name,
        path: input.name,
        visibility: input.visibility,
        ...(namespaceId ? { namespace_id: namespaceId } : {}),
      },
    });
    return {
      httpsUrl: `${created.web_url}.git`,
      defaultBranch: created.default_branch || 'main',
    };
  }
}
