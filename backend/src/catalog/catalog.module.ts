import { Global, Module } from '@nestjs/common';
import { ClaudeModule } from '../claude/claude.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Global()
@Module({
  imports: [ClaudeModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
