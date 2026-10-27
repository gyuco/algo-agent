import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { closeSignal, sendEvents } from '../common/sse.js';
import { WorkflowRunDto } from './dto/workflow-run.dto.js';
import { WorkflowsService } from './workflows.service.js';

@Controller('projects/:projectId/workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  /** Latest runs of the project, newest first. */
  @Get('runs')
  runs(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
  ) {
    return this.workflows.runs(req.user.sub, projectId);
  }

  /** Runs a workflow, streaming its steps as Server-Sent Events. */
  @Post(':key/runs')
  async run(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('key') key: string,
    @Body() dto: WorkflowRunDto,
  ) {
    const events = this.workflows.run(
      req.user.sub,
      projectId,
      key,
      dto.input,
      closeSignal(res),
    );
    await sendEvents(res, events);
  }
}
