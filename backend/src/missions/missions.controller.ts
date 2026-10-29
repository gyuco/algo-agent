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
import { BudgetGuard } from './budget-guard.service.js';
import { MissionScheduler } from './mission-scheduler.service.js';
import { MissionTasksService } from './mission-tasks.service.js';
import { MissionsService } from './missions.service.js';
import {
  ApproveMissionDto,
  CreateMissionDto,
  MissionEventsQueryDto,
  MissionMessageDto,
  MissionModeDto,
  MissionsQueryDto,
  NewProjectMissionDto,
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
    private readonly budget: BudgetGuard,
  ) {}

  @Get()
  list(@Req() req: AuthenticatedRequest, @Query() query: MissionsQueryDto) {
    return this.missions.list(req.user.sub, query);
  }

  /** §8.2: a mission that creates its project at approval. */
  @Post('new-project')
  createNewProject(
    @Req() req: AuthenticatedRequest,
    @Body() dto: NewProjectMissionDto,
  ) {
    return this.missions.createNewProject(req.user.sub, dto);
  }

  /** The user's windows and the missions waiting on the budget, for Activity. */
  @Get('budget')
  budgetOverview(@Req() req: AuthenticatedRequest) {
    return this.budget.userView(req.user.sub);
  }

  /** §7.1: every entry of the user's missions, live: the notifications stream. */
  @Get('active/events')
  async activeEvents(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query() query: MissionEventsQueryDto,
    @Headers('last-event-id') lastEventId?: string,
  ) {
    const after = query.after ?? (Number(lastEventId) || 0);
    await streamEvents(
      res,
      (signal) => this.missions.followUser(req.user.sub, after, signal),
      (entry) => ({ id: entry.id, data: this.missions.entryView(entry) }),
    );
  }

  /** §7.1: Richiedono te and In corso. */
  @Get('activity')
  activity(@Req() req: AuthenticatedRequest) {
    return this.missions.activity(req.user.sub);
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

  /** §7.1: the mission is read; its notifications stop counting. */
  @Post(':id/seen')
  @HttpCode(HttpStatus.OK)
  seen(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.missions.seen(req.user.sub, id);
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
  async approve(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveMissionDto,
  ) {
    const mission = await this.missions.approve(req.user.sub, id, dto);
    this.scheduler.wake(id);
    return mission;
  }

  /** §6.3: after a failed push or pull request. */
  @Post(':id/publish/retry')
  @HttpCode(HttpStatus.OK)
  retryPublish(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.retryPublish(req.user.sub, id);
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

  /** §5.1: switch between step by step and automatic during the mission. */
  @Post(':id/mode')
  @HttpCode(HttpStatus.OK)
  setMode(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MissionModeDto,
  ) {
    return this.tasks.setMode(req.user.sub, id, dto.mode);
  }

  /** §5.7: accept the task's perimeter violations and widen the plan. */
  @Post(':id/scope/accept')
  @HttpCode(HttpStatus.OK)
  acceptScope(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.acceptScope(req.user.sub, id);
  }

  /** After `weekly_budget` or `usd_budget`: one more allowance. */
  @Post(':id/continue')  @HttpCode(HttpStatus.OK)
  continueBudget(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.tasks.continueBudget(req.user.sub, id);
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

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    const mission = await this.scheduler.withLock(id, async () => {
      const resumed = await this.missions.resume(req.user.sub, id);
      await this.scheduler.resumeTasks(id);
      return resumed;
    });
    this.scheduler.wake(id);
    return mission;
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
