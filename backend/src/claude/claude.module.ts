import { Module } from '@nestjs/common';
import { ClaudeController } from './claude.controller.js';
import { ClaudeService } from './claude.service.js';

@Module({
  controllers: [ClaudeController],
  providers: [ClaudeService],
  exports: [ClaudeService],
})
export class ClaudeModule {}
