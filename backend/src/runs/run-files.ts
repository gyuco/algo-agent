import { Injectable } from '@nestjs/common';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UserAttachment } from '../providers/provider.js';
import { RunConfig } from './run-config.js';

/** Chat attachments, kept on disk from the request until the turn ends: they're too large for the database. */
@Injectable()
export class RunFiles {
  constructor(private readonly config: RunConfig) {}

  private file(runId: number) {
    return join(this.config.dataDir(), 'run-attachments', `${runId}.json`);
  }

  async saveAttachments(runId: number, attachments: UserAttachment[]) {
    if (!attachments.length) return;
    const file = this.file(runId);
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(attachments), { mode: 0o600 });
  }

  async attachments(runId: number): Promise<UserAttachment[]> {
    try {
      return JSON.parse(
        await readFile(this.file(runId), 'utf8'),
      ) as UserAttachment[];
    } catch {
      return [];
    }
  }

  async remove(runId: number) {
    await rm(this.file(runId), { force: true });
  }
}
