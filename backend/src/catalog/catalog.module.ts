import { Global, Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Global()
@Module({
  imports: [ConnectionsModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
