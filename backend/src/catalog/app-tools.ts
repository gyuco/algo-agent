import {
  tool,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';

/** What a tool knows about the run it serves. */
export interface ToolContext {
  /** The project folder, already resolved and confined. */
  cwd: string;
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
};
