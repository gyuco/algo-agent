import type { RunEventData } from './run-types.js';
import { TextCoalescer } from './text-coalescer.js';

describe('TextCoalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const out: RunEventData[] = [];
    return { out, coalescer: new TextCoalescer((e) => out.push(e), 250) };
  }

  it('merges consecutive text of the same thread', () => {
    const { out, coalescer } = setup();
    coalescer.push({ type: 'text', text: 'Hel' });
    coalescer.push({ type: 'text', text: 'lo' });
    expect(out).toEqual([]);
    vi.advanceTimersByTime(250);
    expect(out).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('closes the text before an event of another kind', () => {
    const { out, coalescer } = setup();
    coalescer.push({ type: 'text', text: 'a' });
    coalescer.push({ type: 'tool', name: 'Read', target: 'x.ts' });
    coalescer.push({ type: 'text', text: 'b' });
    coalescer.flush();
    expect(out).toEqual([
      { type: 'text', text: 'a' },
      { type: 'tool', name: 'Read', target: 'x.ts' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('keeps delegations apart', () => {
    const { out, coalescer } = setup();
    coalescer.push({ type: 'text', text: 'main' });
    coalescer.push({ type: 'text', text: 'sub', delegation: 'd1' });
    coalescer.flush();
    expect(out).toEqual([
      { type: 'text', text: 'main' },
      { type: 'text', text: 'sub', delegation: 'd1' },
    ]);
  });
});
