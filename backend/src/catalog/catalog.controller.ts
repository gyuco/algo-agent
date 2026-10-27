import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
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
    return this.catalog.library(req.user.sub);
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
    return this.catalog.create(req.user.sub, editableKind(kind), key, spec);
  }

  @Put(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  update(
    @Req() req: AuthenticatedRequest,
    @Param('kind') kind: string,
    @Param('key') key: string,
    @Body() spec: unknown,
  ) {
    return this.catalog.update(req.user.sub, editableKind(kind), key, spec);
  }

  @Delete(':kind/:key')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Req() req: AuthenticatedRequest,
    @Param('kind') kind: string,
    @Param('key') key: string,
  ) {
    return this.catalog.remove(req.user.sub, editableKind(kind), key);
  }
}
