import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { BrowseDto, ProjectDto } from './dto/project.dto.js';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.projects.list(req.user.sub);
  }

  /** §8.5: the name of a new project is free. */
  @Get('folder-available')
  folderAvailable(@Query('name') name: string) {
    return this.projects.folderAvailable(name ?? '');
  }

  /** Folder listing for the path picker. */
  @Get('browse')
  browse(@Query() dto: BrowseDto) {
    return this.projects.browse(dto.path);
  }

  @Get(':id')
  get(@Req() req: AuthenticatedRequest, @Param('id', ParseIntPipe) id: number) {
    return this.projects.get(req.user.sub, id);
  }

  @Post()
  create(@Req() req: AuthenticatedRequest, @Body() dto: ProjectDto) {
    return this.projects.create(req.user.sub, dto);
  }

  @Put(':id')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ProjectDto,
  ) {
    return this.projects.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.projects.remove(req.user.sub, id);
  }
}
