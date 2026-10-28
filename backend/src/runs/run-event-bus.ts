import { Injectable } from '@nestjs/common';
import type { RunActivity, SequencedEvent } from './run-types.js';

/** A change the user's lists of runs should show. */
export type RunNotice =
  /** Status, wait reason or anything else about the run changed: fetch it again. */
  | { type: 'changed'; runId: number }
  /** What the run is doing now; kept in memory only. */
  | { type: 'activity'; runId: number; activity: RunActivity };

type Listener<T> = (value: T) => void;

function add<K, T>(map: Map<K, Set<Listener<T>>>, key: K, l: Listener<T>) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (set.size === 0 && map.get(key) === set) map.delete(key);
  };
}

/** Hands live events to the clients following a run, and run changes to the user's lists. In memory: one instance. */
@Injectable()
export class RunEventBus {
  /** `null` tells a run's listeners it ended. */
  private readonly runs = new Map<
    number,
    Set<Listener<SequencedEvent | null>>
  >();
  private readonly users = new Map<number, Set<Listener<RunNotice>>>();

  /** Returns the function that unsubscribes. */
  subscribe(runId: number, listener: Listener<SequencedEvent | null>) {
    return add(this.runs, runId, listener);
  }

  publish(runId: number, event: SequencedEvent) {
    for (const l of this.runs.get(runId) ?? []) l(event);
  }

  /** The run reached a final status: its listeners stop and are dropped. */
  end(runId: number) {
    const listeners = this.runs.get(runId);
    this.runs.delete(runId);
    for (const l of listeners ?? []) l(null);
  }

  watch(userId: number, listener: Listener<RunNotice>) {
    return add(this.users, userId, listener);
  }

  notify(userId: number, notice: RunNotice) {
    for (const l of this.users.get(userId) ?? []) l(notice);
  }
}

/**
 * Turns pushed values into an async generator: values are buffered until read.
 * Ends when `push(null)` is called or `signal` fires; `onClose` then runs once.
 */
export function channel<T>(signal: AbortSignal) {
  const buffer: T[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const closers: (() => void)[] = [];

  const finish = () => {
    if (ended) return;
    ended = true;
    closers.forEach((close) => close());
    wake?.();
  };
  signal.addEventListener('abort', finish, { once: true });

  return {
    push(value: T | null) {
      if (ended) return;
      if (value === null) return finish();
      buffer.push(value);
      wake?.();
    },
    onClose(close: () => void) {
      if (ended) close();
      else closers.push(close);
    },
    /** Values already pushed, removed from the buffer. */
    drain() {
      return buffer.splice(0);
    },
    async *values(): AsyncGenerator<T> {
      try {
        for (;;) {
          while (buffer.length) yield buffer.shift()!;
          if (ended || signal.aborted) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = null;
        }
      } finally {
        finish();
      }
    },
  };
}
