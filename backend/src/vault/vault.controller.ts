import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
  Req,
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ProjectsService } from '../projects/projects.service.js';
import { VaultService } from './vault.service.js';

export class SecretValueDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  value: string;
}

/** A secret's name, as MCP servers write it in `${NAME}`. */
function secretName(name: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new BadRequestException(
      'Nome del segreto non valido (lettere, cifre e _, non inizia con una cifra)',
    );
  }
  return name;
}

/** The user's own secrets, seen by all their projects. */
@Controller('secrets')
export class UserVaultController {
  constructor(private readonly vault: VaultService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.vault.list(req.user.sub, null);
  }

  @Put(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  set(
    @Req() req: AuthenticatedRequest,
    @Param('name') name: string,
    @Body() dto: SecretValueDto,
  ) {
    return this.vault.set(req.user.sub, null, secretName(name), dto.value);
  }

  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Req() req: AuthenticatedRequest, @Param('name') name: string) {
    return this.vault.remove(req.user.sub, null, secretName(name));
  }
}

/** One project's secrets; they override the user's ones of the same name. */
@Controller('projects/:projectId/secrets')
export class ProjectVaultController {
  constructor(
    private readonly vault: VaultService,
    private readonly projects: ProjectsService,
  ) {}

  @Get()
  async list(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
  ) {
    await this.projects.get(req.user.sub, projectId);
    return this.vault.list(req.user.sub, projectId);
  }

  @Put(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async set(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('name') name: string,
    @Body() dto: SecretValueDto,
  ) {
    await this.projects.get(req.user.sub, projectId);
    await this.vault.set(req.user.sub, projectId, secretName(name), dto.value);
  }

  @Delete(':name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('projectId', ParseIntPipe) projectId: number,
    @Param('name') name: string,
  ) {
    await this.projects.get(req.user.sub, projectId);
    await this.vault.remove(req.user.sub, projectId, secretName(name));
  }
}
