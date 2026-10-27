import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Put,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { RESOURCE_KINDS, type ResourceKind } from '../catalog/catalog.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { ResourceSwitchDto } from './dto/resource.dto.js';
import { ProjectResourcesService } from './project-resources.service.js';

/** The user's library as seen by one project, and the project's on/off switches. */
@Controller('projects/:projectId/resources')
export class AgentsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly resources: ProjectResourcesService,
    private readonly catalog: CatalogService,
  ) {}

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
  ) {
    await this.projects.get(req.user.sub, projectId);
    return this.resources.list(
      projectId,
      await this.catalog.forUser(req.user.sub),
    );
  }

  @Put(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async set(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('kind') kind: string,
    @Param('key') key: string,
    @Body() dto: ResourceSwitchDto,
  ) {
    await this.projects.get(req.user.sub, projectId);
    if (!(RESOURCE_KINDS as readonly string[]).includes(kind)) {
      throw new NotFoundException('Tipo di risorsa sconosciuto');
    }
    await this.resources.set(
      projectId,
      await this.catalog.forUser(req.user.sub),
      kind as ResourceKind,
      key,
      dto.enabled,
    );
  }
}
