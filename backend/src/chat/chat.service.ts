import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { homedir } from 'node:os';
import {
  AgentRunnerService,
  type ChatEvent,
} from '../agents/agent-runner.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import {
  ChatMessageDto,
  IMAGE_TYPES,
  type AttachmentDto,
} from './dto/chat.dto.js';
import { describeWorkspace, resolveWorkspace } from './workspace.js';

/** Agent that answers when the chat doesn't pick one. */
export const DEFAULT_AGENT = 'assistant';

type UserContent = Exclude<SDKUserMessage['message']['content'], string>;

/** One Messages API content block per attachment, then the typed text. */
function userContent(
  message: string,
  attachments: AttachmentDto[],
): UserContent {
  const blocks: UserContent = attachments.map((a) => {
    if ((IMAGE_TYPES as readonly string[]).includes(a.mediaType)) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: a.mediaType as (typeof IMAGE_TYPES)[number],
          data: a.data,
        },
      };
    }
    if (a.mediaType === 'application/pdf') {
      return {
        type: 'document',
        title: a.name,
        source: { type: 'base64', media_type: 'application/pdf', data: a.data },
      };
    }
    return {
      type: 'document',
      title: a.name,
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: Buffer.from(a.data, 'base64').toString('utf8'),
      },
    };
  });
  if (message) blocks.push({ type: 'text', text: message });
  return blocks;
}

/** A single user turn in streaming-input form, the only form that carries attachments. */
async function* singleTurn(
  content: UserContent,
): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

@Injectable()
export class ChatService {
  constructor(
    private readonly runner: AgentRunnerService,
    private readonly projects: ProjectsService,
    private readonly config: ConfigService,
  ) {}

  workspaceRoot() {
    return this.config.get<string>('WORKSPACE_ROOT') || homedir();
  }

  async workspace(path: string) {
    return describeWorkspace(
      await resolveWorkspace(path, this.workspaceRoot()),
    );
  }

  /** Runs one user turn with the chosen agent and yields its chat events. */
  async *send(
    userId: number,
    dto: ChatMessageDto,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    const project = await this.projects.get(userId, dto.projectId);
    yield* this.runner.run({
      userId,
      project,
      agent: dto.agent ?? DEFAULT_AGENT,
      prompt: dto.attachments?.length
        ? singleTurn(userContent(dto.message, dto.attachments))
        : dto.message,
      sessionId: dto.sessionId,
      model: dto.model,
      signal,
    });
  }
}
