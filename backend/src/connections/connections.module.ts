import { Module } from '@nestjs/common';
import { ConnectionsService } from './connections.service.js';

@Module({
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
