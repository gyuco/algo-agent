import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { AppToolDefinition } from './app-mcp.js';

/** The app's tools of one run, reachable over MCP with the run's token until it is closed. */
export interface AppMcpRun {
  url: string;
  token: string;
  close: () => void;
}

/**
 * Serves the app's tools over HTTP MCP to runtimes that run out of process
 * (OpenCode). Each run gets its own token, valid only while the run lasts and
 * only for the tools its agent may use.
 */
@Injectable()
export class AppMcpService {
  private readonly runs = new Map<string, AppToolDefinition[]>();

  constructor(private readonly config: ConfigService) {}

  open(tools: AppToolDefinition[]): AppMcpRun {
    const token = randomBytes(32).toString('base64url');
    this.runs.set(token, tools);
    const port = this.config.get<string>('PORT') ?? '3000';
    return {
      url: `http://127.0.0.1:${port}/api/app-mcp`,
      token,
      close: () => this.runs.delete(token),
    };
  }

  /** The tools of the run the token belongs to, if it is still open. */
  toolsFor(token: string): AppToolDefinition[] | undefined {
    return this.runs.get(token);
  }
}
