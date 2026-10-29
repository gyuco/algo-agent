import { Controller, Get } from '@nestjs/common';
import { Sandbox } from './sandbox.js';

/** What the UI asks before showing Approve. */
@Controller('system')
export class SystemController {
  constructor(private readonly sandbox: Sandbox) {}

  @Get('sandbox')
  sandboxStatus() {
    return this.sandbox.available();
  }
}
