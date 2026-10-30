import {
  tool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  AWS_TOOL_PROMPT,
  AwsCommandError,
  awsArgs,
  awsEnv,
  runAws,
} from './aws-tool.js';

/** What a mission tool knows about the turn it serves. */
export interface MissionToolContext {
  missionId: number;
  runId: number;
  /** Set for a task's run: its worktree and the commit its diff starts from. */
  taskId?: number;
  worktree?: string;
  taskBase?: string;
}

/** What a tool knows about the run it serves. */
export interface ToolContext {
  /** The project folder, already resolved and confined. */
  cwd: string;
  /** Set only for the mission orchestrator's tools. */
  mission?: MissionToolContext;
  /** The run's secrets: the project's, then the user's. */
  variables?: Record<string, string>;
}

export interface AppTool {
  description: string;
  /** Switched on in a project until the project turns it off. */
  enabledByDefault: boolean;
  create: (ctx: ToolContext) => SdkMcpToolDefinition<any>;
}

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
});

const failure = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
  isError: true,
});

/**
 * Tools written in code, served to agents by the in-process `app` MCP server.
 * The key is the tool name; an agent lists it under `permissions.tools`.
 */
export const APP_TOOLS: Record<string, AppTool> = {
  current_datetime: {
    description: 'Data e ora correnti del server, con fuso orario.',
    enabledByDefault: true,
    create: () =>
      tool(
        'current_datetime',
        'Returns the current date and time of the server (ISO 8601) and its time zone.',
        {},
        async () =>
          text(
            JSON.stringify({
              now: new Date().toISOString(),
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          ),
        { annotations: { readOnlyHint: true } },
      ),
  },
  aws: {
    description:
      "AWS CLI in sola lettura su CloudWatch Logs e metriche, con l'account dei segreti AWS_PROFILE e AWS_REGION.",
    enabledByDefault: false,
    create: (ctx) =>
      tool(
        'aws',
        AWS_TOOL_PROMPT,
        { command: z.string().trim().min(1).max(4_000) },
        async ({ command }) => {
          let args: string[];
          let env: Record<string, string>;
          try {
            args = awsArgs(command);
            env = awsEnv(ctx.variables ?? {});
          } catch (error) {
            if (error instanceof AwsCommandError) return failure(error.message);
            throw error;
          }
          const result = await runAws(args, env, ctx.cwd);
          return result.ok ? text(result.text) : failure(result.text);
        },
        { annotations: { readOnlyHint: true } },
      ),
  },
};
