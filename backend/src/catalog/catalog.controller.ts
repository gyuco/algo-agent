import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ProjectsService } from '../projects/projects.service.js';
import { EDITABLE_KINDS, type EditableKind } from './catalog.js';
import { CatalogService } from './catalog.service.js';

function editableKind(kind: string): EditableKind {
  if (!(EDITABLE_KINDS as readonly string[]).includes(kind)) {
    throw new NotFoundException('Tipo di risorsa sconosciuto');
  }
  return kind as EditableKind;
}

/**
 * The user's resource library. Bodies are resource specs, validated by the
 * catalog schemas (zod) rather than DTO classes.
 */
@Controller('resources')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  library(@Req() req: AuthenticatedRequest) {
    return this.catalog.library(req.user.sub, null);
  }

  @Post('import-examples')
  @HttpCode(HttpStatus.OK)
  importExamples(@Req() req: AuthenticatedRequest) {
    return this.catalog.importExamples(req.user.sub);
  }

  @Post(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  create(
    @Req() req: AuthenticatedRequest,
    @Param('kind') kind: string,
    @Param('key') key: string,
    @Body() spec: unknown,
  ) {
    return this.catalog.create(
      req.user.sub,
      null,
      editableKind(kind),
      key,
      spec,
    );
  }

  @Put(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  update(
    @Req() req: AuthenticatedRequest,
    @Param('kind') kind: string,
    @Param('key') key: string,
    @Body() spec: unknown,
  ) {
    return this.catalog.update(
      req.user.sub,
      null,
      editableKind(kind),
      key,
      spec,
    );
  }

  @Delete(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('kind') kind: string,
    @Param('key') key: string,
  ) {
    return this.catalog.remove(req.user.sub, null, editableKind(kind), key);
  }
}

/**
 * Resources of one project only, next to the library it also sees: `GET`
 * returns both, with the project's own listed in `own`.
 */
@Controller('projects/:projectId/library')
export class ProjectCatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly projects: ProjectsService,
  ) {}

  @Get()
  async library(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
  ) {
    await this.projects.get(req.user.sub, projectId);
    return this.catalog.library(req.user.sub, projectId);
  }

  @Post(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async create(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('kind') kind: string,
    @Param('key') key: string,
    @Body() spec: unknown,
  ) {
    await this.projects.get(req.user.sub, projectId);
    await this.catalog.create(
      req.user.sub,
      projectId,
      editableKind(kind),
      key,
      spec,
    );
  }

  @Put(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('kind') kind: string,
    @Param('key') key: string,
    @Body() spec: unknown,
  ) {
    await this.projects.get(req.user.sub, projectId);
    await this.catalog.update(
      req.user.sub,
      projectId,
      editableKind(kind),
      key,
      spec,
    );
  }

  @Delete(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('kind') kind: string,
    @Param('key') key: string,
  ) {
    await this.projects.get(req.user.sub, projectId);
    await this.catalog.remove(req.user.sub, projectId, editableKind(kind), key);
  }
}
