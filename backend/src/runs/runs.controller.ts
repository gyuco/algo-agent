import {
  Controller,
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
import { FollowQueryDto } from './dto/runs.dto.js';
import { RunsService } from './runs.service.js';

/** Runs of either kind, once started: follow, stop, resume. Starting one is up to the workflow and chat routes. */
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  /** Queued, running and waiting runs in all projects, plus the ones finished in the last day. */
  @Get('active')
  active(@Req() req: AuthenticatedRequest) {
    return this.runs.active(req.user.sub);
  }

  /** Changes to the user's runs as Server-Sent Events: statuses and what each is doing, no text. */
  @Get('active/events')
  async watch(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    await streamEvents(res, (signal) => this.runs.watch(req.user.sub, signal));
  }

  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.runs.get(req.user.sub, id);
  }

  /** The run's events after `after` (or `Last-Event-ID`), then live ones until it ends. Closing it doesn't stop the run. */
  @Get(':id/events')
  async follow(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: FollowQueryDto,
    @Headers('last-event-id') lastEventId?: string,
  ) {
    // Checked before the stream opens, so a missing run is a plain 404.
    await this.runs.find(req.user.sub, id);
    const after = query.after ?? (Number(lastEventId) || 0);
    await streamEvents(
      res,
      (signal) => this.runs.follow(req.user.sub, id, after, signal),
      (event) => ({ id: event.seq, data: event.data }),
    );
  }

  @Post(':id/abort')
  @HttpCode(HttpStatus.ACCEPTED)
  async abort(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.runs.abort(req.user.sub, id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.ACCEPTED)
  resume(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.runs.resume(req.user.sub, id);
  }

  @Post(':id/seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  async seen(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.runs.seen(req.user.sub, id);
  }
}
