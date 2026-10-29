import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { streamEvents } from '../common/sse.js';
import { MissionsService } from './missions.service.js';
import {
  ApproveMissionDto,
  CreateMissionDto,
  MissionEventsQueryDto,
  MissionMessageDto,
  MissionsQueryDto,
} from './dto/mission.dto.js';

/** Starts a mission in one of the user's projects. */
@Controller('projects/:projectId/missions')
export class ProjectMissionsController {
  constructor(private readonly missions: MissionsService) {}

  @Post()
  create(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Body() dto: CreateMissionDto,
  ) {
    return this.missions.create(req.user.sub, projectId, dto);
  }
}

/** The user's missions: read, follow, comment, approve. */
@Controller('missions')
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query() query: MissionsQueryDto) {
    return this.missions.list(req.user.sub, query);
  }

  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.missions.get(req.user.sub, id);
  }

  @Get(':id/entries')
  entries(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.missions.entries(req.user.sub, id);
  }

  /** New log entries after `after` (or `Last-Event-ID`), then live ones. */
  @Get(':id/events')
  async events(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: MissionEventsQueryDto,
    @Headers('last-event-id') lastEventId?: string,
  ) {
    await this.missions.get(req.user.sub, id);
    const after = query.after ?? (Number(lastEventId) || 0);
    await streamEvents(
      res,
      (signal) => this.missions.follow(req.user.sub, id, after, signal),
      (entry) => ({ id: entry.id, data: this.missions.entryView(entry) }),
    );
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.ACCEPTED)
  messages(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MissionMessageDto,
  ) {
    return this.missions.messages(req.user.sub, id, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveMissionDto,
  ) {
    return this.missions.approve(req.user.sub, id, dto);
  }

  @Post(':id/revise')
  @HttpCode(HttpStatus.OK)
  revise(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.missions.revise(req.user.sub, id);
  }

  @Post(':id/abort')
  @HttpCode(HttpStatus.ACCEPTED)
  abort(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.missions.abort(req.user.sub, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.missions.remove(req.user.sub, id);
  }
}
