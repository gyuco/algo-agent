import type { RunEventData } from './run-types.js';

type TextEvent = Extract<RunEventData, { type: 'text' }>;

/**
 * Merges consecutive `text` events of the same thread into one, closed at most
 * every `delayMs` or when an event of another kind (or thread) arrives. Every
 * event leaves through `emit`, in order: what clients see live is exactly what
 * gets stored, so catching up never repeats or drops text.
 */
export class TextCoalescer {
  private pending: TextEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (event: RunEventData) => void,
    private readonly delayMs = 250,
  ) {}

  push(event: RunEventData) {
    if (event.type !== 'text') {
      this.flush();
      this.emit(event);
      return;
    }
    if (this.pending && this.pending.delegation === event.delegation) {
      this.pending.text += event.text;
      return;
    }
    this.flush();
    this.pending = { ...event };
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) this.emit(pending);
  }
}
