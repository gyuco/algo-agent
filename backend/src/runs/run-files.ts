import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UserAttachment } from '../providers/provider.js';
import { RunConfig } from './run-config.js';

/** Chat attachments, kept on disk from the request until the turn ends: they're too large for the database. */
@Injectable()
export class RunFiles {
  constructor(private readonly config: RunConfig) {}

  private dir() {
    return join(this.config.dataDir(), 'run-attachments');
  }

  private file(runId: number) {
    return join(this.dir(), `${runId}.json`);
  }

  /** Where a conversation's attachments stay after their turns, so a mission can start from them. */
  private sessionFile(sessionId: string) {
    const hash = createHash('sha256').update(sessionId).digest('hex');
    return join(this.config.dataDir(), 'session-attachments', `${hash}.json`);
  }

  async saveAttachments(runId: number, attachments: UserAttachment[]) {
    if (!attachments.length) return;
    const file = this.file(runId);
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
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

  /** Keeps the turn's attachments for the conversation; the run's own copy is removed. */
  async saveSession(sessionId: string, attachments: UserAttachment[]) {
    if (!attachments.length) return;
    const previous = await this.sessionAttachments(sessionId);
    const seen = new Set<string>();
    const merged = [...previous, ...attachments].filter((a) => {
      const key = `${a.name}:${a.mediaType}:${a.data.length}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const file = this.sessionFile(sessionId);
    await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(merged.slice(-5)), {
      mode: 0o600,
    });
  }

  async sessionAttachments(sessionId: string): Promise<UserAttachment[]> {
    try {
      return JSON.parse(
        await readFile(this.sessionFile(sessionId), 'utf8'),
      ) as UserAttachment[];
    } catch {
      return [];
    }
  }

  async remove(runId: number) {
    await rm(this.file(runId), { force: true });
  }

  /** Forgets a conversation's attachments when the conversation goes away. */
  async removeSession(sessionId: string) {
    await rm(this.sessionFile(sessionId), { force: true });
  }

  /**
   * Deletes the attachment files not touched since `before`: runs of finished
   * turns clean their own, but conversations' copies would stay forever.
   */
  async cleanUp(before: Date) {
    for (const dir of [this.dir(), join(this.config.dataDir(), 'session-attachments')]) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        // The folder never existed: nothing to clean.
        continue;
      }
      for (const name of names) {
        const file = join(dir, name);
        const info = await stat(file).catch(() => null);
        if (info?.isFile() && info.mtime < before) {
          await rm(file, { force: true }).catch(() => undefined);
        }
      }
    }
  }
}
