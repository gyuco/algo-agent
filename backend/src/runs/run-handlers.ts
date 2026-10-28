import { Injectable } from '@nestjs/common';
import type { RunHandler, RunKind } from './run-types.js';

/** Who runs each kind of run: the workflow and chat modules register here, so this module needs neither. */
@Injectable()
export class RunHandlers {
  private readonly handlers = new Map<string, RunHandler>();

  register(kind: RunKind, handler: RunHandler) {
    this.handlers.set(kind, handler);
  }

  get(kind: string): RunHandler {
    const handler = this.handlers.get(kind);
    if (!handler) throw new Error(`No handler for ${kind} runs`);
    return handler;
  }
}
