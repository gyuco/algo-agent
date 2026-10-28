import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ChatService } from './chat.service.js';
import {
  ChatMessageDto,
  SessionParamsDto,
  SessionsQueryDto,
  WorkspaceDto,
} from './dto/chat.dto.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('workspace')
  @HttpCode(HttpStatus.OK)
  workspace(@Body() dto: WorkspaceDto) {
    return this.chat.workspace(dto.path);
  }

  /** Queues one chat turn; follow it with GET /runs/:id/events. */
  @Post('messages')
  @HttpCode(HttpStatus.ACCEPTED)
  send(@Req() req: AuthenticatedRequest, @Body() dto: ChatMessageDto) {
    return this.chat.send(req.user.sub, dto);
  }

  /** The project's past conversations, newest first. */
  @Get('sessions')
  sessions(@Req() req: AuthenticatedRequest, @Query() query: SessionsQueryDto) {
    return this.chat.sessions(req.user.sub, query.projectId);
  }

  /** A past conversation's messages, to show it and continue it. */
  @Get('sessions/:sessionId')
  history(
    @Req() req: AuthenticatedRequest,
    @Param() params: SessionParamsDto,
    @Query() query: SessionsQueryDto,
  ) {
    return this.chat.history(req.user.sub, query.projectId, params.sessionId);
  }
}
