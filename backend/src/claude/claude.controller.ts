import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { toConnectionStatus } from '../providers/providers.service.js';
import { ClaudeProvider } from './claude.provider.js';
import { ApiKeyDto } from './dto/api-key.dto.js';
import { CompleteSetupTokenDto, OAuthTokenDto } from './dto/oauth.dto.js';

/** Ways to connect Claude Code; status and disconnect are under /connections. */
@Controller('connections/claude')
export class ClaudeController {
  constructor(private readonly claude: ClaudeProvider) {}

  @Put('api-key')
  async connectApiKey(
    @Req() req: AuthenticatedRequest,
    @Body() dto: ApiKeyDto,
  ) {
    return toConnectionStatus(
      this.claude,
      await this.claude.connectApiKey(req.user.sub, dto.apiKey),
    );
  }

  @Post('setup-token')
  startSetupToken(@Req() req: AuthenticatedRequest) {
    return this.claude.startSetupToken(req.user.sub);
  }

  @Post('setup-token/complete')
  @HttpCode(HttpStatus.OK)
  async completeSetupToken(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CompleteSetupTokenDto,
  ) {
    return toConnectionStatus(
      this.claude,
      await this.claude.completeSetupToken(
        req.user.sub,
        dto.sessionId,
        dto.code,
      ),
    );
  }

  @Post('usage/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshUsage(@Req() req: AuthenticatedRequest) {
    return toConnectionStatus(
      this.claude,
      await this.claude.refreshUsage(req.user.sub),
    );
  }

  @Put('oauth-token')
  async connectOAuthToken(
    @Req() req: AuthenticatedRequest,
    @Body() dto: OAuthTokenDto,
  ) {
    return toConnectionStatus(
      this.claude,
      await this.claude.connectOAuthToken(req.user.sub, dto.token),
    );
  }
}
