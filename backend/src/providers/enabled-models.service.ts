import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The models each user has switched on in their resources. While the list is
 * not empty, chats offer only these; an empty list means no restriction.
 */
@Injectable()
export class EnabledModelsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Model references (`<provider>:<id>`) the user switched on, in order. */
  async list(userId: number): Promise<string[]> {
    const rows = await this.prisma.enabledModel.findMany({
      where: { userId },
      orderBy: { value: 'asc' },
      select: { value: true },
    });
    return rows.map((row) => row.value);
  }

  async set(userId: number, value: string, enabled: boolean) {
    if (enabled) {
      await this.prisma.enabledModel.upsert({
        where: { userId_value: { userId, value } },
        create: { userId, value },
        update: {},
      });
      return;
    }
    await this.prisma.enabledModel.deleteMany({ where: { userId, value } });
  }
}
