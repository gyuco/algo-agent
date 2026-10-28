import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { StepRejectDto } from './dto/step-reject.dto.js';
import { WorkflowsService } from './workflows.service.js';

/** Approving or rejecting a workflow step that waits for the user. */
@Controller('runs/:id/steps/:stepId')
export class RunStepsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Post('approve')
  @HttpCode(HttpStatus.ACCEPTED)
  async approve(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('stepId') stepId: string,
  ) {
    await this.workflows.approve(req.user.sub, id, stepId);
  }

  @Post('reject')
  @HttpCode(HttpStatus.ACCEPTED)
  async reject(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('stepId') stepId: string,
    @Body() dto: StepRejectDto,
  ) {
    await this.workflows.reject(req.user.sub, id, stepId, dto.note);
  }
}
