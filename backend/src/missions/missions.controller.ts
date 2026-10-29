import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
import { MissionScheduler } from './mission-scheduler.service.js';
import { MissionTasksService } from './mission-tasks.service.js';
import { MissionsService } from './missions.service.js';
import {
  ApproveMissionDto,
  CreateMissionDto,
  MissionEventsQueryDto,
  MissionMessageDto,
  MissionsQueryDto,
  RedoTaskDto,
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
  constructor(
    private readonly missions: MissionsService,
    private readonly tasks: MissionTasksService,
    private readonly scheduler: MissionScheduler,
  ) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query() query: MissionsQueryDto) {
    return this.missions.list(req.user.sub, query);
  }

  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.missions.get(req.user.sub, id);
  }

  @Get(':id/tasks')
  taskList(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.list(req.user.sub, id);
  }

  @Get(':id/tasks/:key')
  task(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('key') key: string,
  ) {
    return this.tasks.get(req.user.sub, id, key);
  }

  @Get(':id/tasks/:key/diff')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  taskDiff(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('key') key: string,
  ) {
    return this.tasks.diff(req.user.sub, id, key);
  }

  @Post(':id/tasks/:key/ok')
  @HttpCode(HttpStatus.OK)
  taskOk(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('key') key: string,
  ) {
    return this.tasks.ok(req.user.sub, id, key);
  }

  @Post(':id/tasks/:key/redo')
  @HttpCode(HttpStatus.OK)
  taskRedo(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('key') key: string,
    @Body() dto: RedoTaskDto,
  ) {
    return this.tasks.redo(req.user.sub, id, key, dto.note);
  }

  @Post(':id/tasks/:key/skip')
  @HttpCode(HttpStatus.OK)
  taskSkip(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('key') key: string,
  ) {
    return this.tasks.skip(req.user.sub, id, key);
  }

  @Post(':id/final-checks/retry')
  @HttpCode(HttpStatus.OK)
  retryFinalChecks(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.retryFinalChecks(req.user.sub, id);
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

  /** After `baseline`: a new base, then the preparation again. */
  @Post(':id/baseline/retry')
  @HttpCode(HttpStatus.OK)
  retryBaseline(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.missions.retryBaseline(req.user.sub, id);
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
    return this.scheduler.withLock(id, () => this.missions.abort(req.user.sub, id));
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
