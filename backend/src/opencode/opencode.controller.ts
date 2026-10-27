import { Controller, Put, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { toConnectionStatus } from '../providers/providers.service.js';
import { OpencodeProvider } from './opencode.provider.js';

/** Ways to connect OpenCode; status and disconnect are under /connections. */
@Controller('connections/opencode')
export class OpencodeController {
  constructor(private readonly opencode: OpencodeProvider) {}

  @Put('local')
  async connectLocal(@Req() req: AuthenticatedRequest) {
    return toConnectionStatus(
      this.opencode,
      await this.opencode.connectLocal(req.user.sub),
    );
  }
}
