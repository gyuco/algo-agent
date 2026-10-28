import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaBetterSqlite3({
        url: config.getOrThrow<string>('DATABASE_URL'),
        // Several runs write their events at once: wait for the lock instead of failing.
        timeout: 5000,
      }),
    });
  }

  /** Readers don't block the writer, and the other way round. */
  async onModuleInit() {
    await this.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  }

  /** Last of all: runs still store their final status while shutting down. */
  async onApplicationShutdown() {
    await this.$disconnect();
  }
}
