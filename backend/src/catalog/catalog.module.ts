import { Global, Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { VaultModule } from '../vault/vault.module.js';
import {
  CatalogController,
  ProjectCatalogController,
} from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';

@Global()
@Module({
  imports: [ConnectionsModule, VaultModule, ProjectsModule],
  controllers: [CatalogController, ProjectCatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
