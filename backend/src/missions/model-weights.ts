/**
 * Relative weight of an agent session, from the tokens it used. The values are
 * USD per million tokens of the API, so a weight is also a cost estimate: the
 * weekly quota is divided by weight, and `done.costUsd` recalibrates it.
 */
export interface TokenUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Prices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICES: Record<'opus' | 'sonnet' | 'haiku', Prices> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

/** The price family of a model id: opus, sonnet or haiku (sonnet when unknown). */
export function familyOf(model: string) {
  const id = model.toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/** The estimated cost in USD of one session's tokens. */
export function weightOf(tokens: TokenUsage): number {
  const prices = PRICES[familyOf(tokens.model)];
  return (
    (tokens.input * prices.input +
      tokens.output * prices.output +
      tokens.cacheRead * prices.cacheRead +
      tokens.cacheWrite * prices.cacheWrite) /
    1_000_000
  );
}
