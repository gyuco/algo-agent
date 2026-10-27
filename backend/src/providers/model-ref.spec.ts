import { formatRef, parseRef } from './model-ref.js';

const PROVIDERS = ['claude', 'opencode'];

describe('parseRef', () => {
  it('splits a known provider prefix', () => {
    expect(parseRef('opencode:nvidia/z-ai/glm-5.3', PROVIDERS)).toEqual({
      provider: 'opencode',
      id: 'nvidia/z-ai/glm-5.3',
    });
  });

  it('keeps colons inside the id', () => {
    expect(parseRef('opencode:ollama/qwen3:8b', PROVIDERS)).toEqual({
      provider: 'opencode',
      id: 'ollama/qwen3:8b',
    });
  });

  it('reads a bare value as a Claude model', () => {
    expect(parseRef('sonnet', PROVIDERS)).toEqual({
      provider: 'claude',
      id: 'sonnet',
    });
  });

  it('does not take an unknown prefix for a provider', () => {
    expect(parseRef('ollama/qwen3:8b', PROVIDERS)).toEqual({
      provider: 'claude',
      id: 'ollama/qwen3:8b',
    });
  });

  it('round-trips formatRef', () => {
    expect(parseRef(formatRef('opencode', 'a:b'), PROVIDERS)).toEqual({
      provider: 'opencode',
      id: 'a:b',
    });
  });
});
