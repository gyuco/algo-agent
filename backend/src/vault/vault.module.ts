import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import {
  ProjectVaultController,
  UserVaultController,
  VaultForgeController,
} from './vault.controller.js';
import { VaultService } from './vault.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [UserVaultController, ProjectVaultController, VaultForgeController],
  providers: [VaultService],
  exports: [VaultService],
})
export class VaultModule {}
