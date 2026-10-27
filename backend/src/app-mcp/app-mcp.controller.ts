import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { handleRpc, type RpcRequest } from './app-mcp.js';
import { AppMcpService } from './app-mcp.service.js';

/**
 * Streamable HTTP MCP endpoint for the app's tools, answered with plain JSON.
 * Authenticated by a run token, not a user session: runtimes call it, not the browser.
 */
@Public()
@Controller('app-mcp')
export class AppMcpController {
  constructor(private readonly appMcp: AppMcpService) {}

  @Post()
  async rpc(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: RpcRequest | RpcRequest[],
    @Res() res: Response,
  ) {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
    const tools = token ? this.appMcp.toolsFor(token) : undefined;
    if (!tools) {
      res.status(HttpStatus.UNAUTHORIZED).json({ message: 'Run non valida' });
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    const responses = (
      await Promise.all(messages.map((m) => handleRpc(tools, m)))
    ).filter((r) => r !== null);
    if (!responses.length) {
      res.status(HttpStatus.ACCEPTED).end();
      return;
    }
    res.json(Array.isArray(body) ? responses : responses[0]);
  }

  /** No server-initiated stream: every answer comes back on its POST. */
  @Get()
  stream(@Res() res: Response) {
    res.status(HttpStatus.METHOD_NOT_ALLOWED).end();
  }
}
