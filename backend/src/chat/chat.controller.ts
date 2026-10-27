import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { closeSignal, sendEvents } from '../common/sse.js';
import { ChatService } from './chat.service.js';
import { ChatMessageDto, WorkspaceDto } from './dto/chat.dto.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post('workspace')
  @HttpCode(HttpStatus.OK)
  workspace(@Body() dto: WorkspaceDto) {
    return this.chat.workspace(dto.path);
  }

  /** Streams one chat turn as Server-Sent Events. */
  @Post('messages')
  async send(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() dto: ChatMessageDto,
  ) {
    await sendEvents(res, this.chat.send(req.user.sub, dto, closeSignal(res)));
  }
}
