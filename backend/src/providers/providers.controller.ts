import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ProvidersService } from './providers.service.js';

/** Every provider's connection. Connecting has provider-specific routes under /connections/<provider>/. */
@Controller('connections')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.providers.statuses(req.user.sub);
  }

  @Get(':provider')
  status(@Req() req: AuthenticatedRequest, @Param('provider') id: string) {
    return this.providers.status(req.user.sub, id);
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@Req() req: AuthenticatedRequest, @Param('provider') id: string) {
    return this.providers.disconnect(req.user.sub, id);
  }
}
