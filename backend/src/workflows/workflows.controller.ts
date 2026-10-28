import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
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

  /** Queues a run of the workflow; follow it with GET /runs/:id/events. */
  @Post(':key/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  run(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('key') key: string,
    @Body() dto: WorkflowRunDto,
  ) {
    return this.workflows.create(req.user.sub, projectId, key, dto.input);
  }
}
