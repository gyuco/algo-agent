/**
 * Models and sessions are referenced as `<provider>:<id>`, e.g.
 * `opencode:nvidia/z-ai/glm-5.3` or `claude:sonnet`. Ids may contain `:`
 * themselves (`ollama/qwen3:8b`), so only a known provider id counts as prefix.
 */
export interface Ref {
  provider: string;
  id: string;
}

/** Agents written before there were other providers name a bare Claude model. */
export const LEGACY_PROVIDER = 'claude';

export function formatRef(provider: string, id: string): string {
  return `${provider}:${id}`;
}

export function parseRef(value: string, providers: readonly string[]): Ref {
  const colon = value.indexOf(':');
  if (colon > 0) {
    const provider = value.slice(0, colon);
    if (providers.includes(provider)) {
      return { provider, id: value.slice(colon + 1) };
    }
  }
  return { provider: LEGACY_PROVIDER, id: value };
}
