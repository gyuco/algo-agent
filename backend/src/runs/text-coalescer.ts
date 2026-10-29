import type { RunEventData } from './run-types.js';

type TextEvent = Extract<RunEventData, { type: 'text' }>;
type CheckEvent = Extract<RunEventData, { type: 'check_output' }>;

/**
 * Merges consecutive `text` events of the same thread into one, closed at most
 * every `delayMs` or when an event of another kind (or thread) arrives. Every
 * event leaves through `emit`, in order: what clients see live is exactly what
 * gets stored, so catching up never repeats or drops text.
 */
export class TextCoalescer {
  private pending: TextEvent | null = null;
  private pendingCheck: CheckEvent | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (event: RunEventData) => void,
    private readonly delayMs = 250,
  ) {}

  push(event: RunEventData) {
    if (event.type === 'check_output') {
      if (this.pendingCheck && this.pendingCheck.name === event.name) {
        this.pendingCheck.text += event.text;
        return;
      }
      this.flush();
      this.pendingCheck = { ...event };
      this.timer = setTimeout(() => this.flush(), this.delayMs);
      return;
    }
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
    const pendingCheck = this.pendingCheck;
    this.pending = null;
    this.pendingCheck = null;
    if (pending) this.emit(pending);
    if (pendingCheck) this.emit(pendingCheck);
  }
}
