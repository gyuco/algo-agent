import { BadRequestException } from '@nestjs/common';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isInside } from '../chat/workspace.js';

/**
 * A working folder the backend chose for an agent: the mission's or task's
 * worktree under `DATA_DIR/worktrees/<projectId>`. It never comes from the
 * user, so it skips `WORKSPACE_ROOT`, but it must stay where it belongs.
 */
export async function trustedWorktreeCwd(
  dataDir: string,
  projectId: number,
  cwd: string,
): Promise<string> {
  const root = join(dataDir, 'worktrees', String(projectId));
  const resolvedRoot = await realpath(root).catch(() => root);
  const resolved = await realpath(cwd).catch(() => null);
  if (!resolved || !isInside(resolvedRoot, resolved)) {
    throw new BadRequestException(
      "La cartella di lavoro dell'agente deve essere un worktree della missione",
    );
  }
  return resolved;
}

/** The briefing folder of a new project, under `DATA_DIR/briefing/<missionId>`. */
export async function trustedBriefingCwd(
  dataDir: string,
  missionId: number,
  cwd: string,
): Promise<string> {
  const root = join(dataDir, 'briefing', String(missionId));
  const resolvedRoot = await realpath(root).catch(() => root);
  const resolved = await realpath(cwd).catch(() => null);
  if (!resolved || !isInside(resolvedRoot, resolved)) {
    throw new BadRequestException(
      "La cartella del briefing deve stare sotto DATA_DIR/briefing",
    );
  }
  return resolved;
}
