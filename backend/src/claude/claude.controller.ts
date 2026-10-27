import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ClaudeService } from './claude.service.js';
import { ApiKeyDto } from './dto/api-key.dto.js';
import { CompleteSetupTokenDto, OAuthTokenDto } from './dto/oauth.dto.js';

@Controller('claude')
export class ClaudeController {
  constructor(private readonly claude: ClaudeService) {}

  @Get('status')
  status(@Req() req: AuthenticatedRequest) {
    return this.claude.status(req.user.sub);
  }

  @Put('api-key')
  connectApiKey(@Req() req: AuthenticatedRequest, @Body() dto: ApiKeyDto) {
    return this.claude.connectApiKey(req.user.sub, dto.apiKey);
  }

  @Post('setup-token')
  startSetupToken(@Req() req: AuthenticatedRequest) {
    return this.claude.startSetupToken(req.user.sub);
  }

  @Post('setup-token/complete')
  @HttpCode(HttpStatus.OK)
  completeSetupToken(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CompleteSetupTokenDto,
  ) {
    return this.claude.completeSetupToken(
      req.user.sub,
      dto.sessionId,
      dto.code,
    );
  }

  @Post('usage/refresh')
  @HttpCode(HttpStatus.OK)
  refreshUsage(@Req() req: AuthenticatedRequest) {
    return this.claude.refreshUsage(req.user.sub);
  }

  @Put('oauth-token')
  connectOAuthToken(
    @Req() req: AuthenticatedRequest,
    @Body() dto: OAuthTokenDto,
  ) {
    return this.claude.connectOAuthToken(req.user.sub, dto.token);
  }

  @Delete('credential')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(@Req() req: AuthenticatedRequest) {
    return this.claude.disconnect(req.user.sub);
  }
}
