import { BadRequestException } from '@nestjs/common';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Whether `target` is `dir` itself or somewhere below it. */
export function isInside(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

/**
 * Resolves a user-chosen working directory: it must exist, be a directory and,
 * after following symlinks, lie inside the configured workspace root.
 */
export async function resolveWorkspace(
  path: string,
  root = homedir(),
): Promise<string> {
  if (!isAbsolute(path)) {
    throw new BadRequestException('Il path deve essere assoluto');
  }
  let real: string;
  try {
    real = await realpath(resolve(path));
  } catch {
    throw new BadRequestException('Cartella non trovata');
  }
  if (!(await stat(real)).isDirectory()) {
    throw new BadRequestException('Il path non è una cartella');
  }
  if (!isInside(await realpath(root), real)) {
    throw new BadRequestException(`La cartella deve trovarsi dentro ${root}`);
  }
  return real;
}

export async function describeWorkspace(path: string) {
  const entries = await readdir(path, { withFileTypes: true });
  return {
    path,
    name: basename(path),
    entries: entries
      .filter((e) => !e.name.startsWith('.'))
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 50)
      .map((e) => ({ name: e.name, dir: e.isDirectory() })),
  };
}

const GLOB_CHAR = /[*?[{]/;

/** Paths a read-only tool call would touch: its file/dir and an absolute glob's fixed prefix. */
function toolPaths(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  for (const key of ['file_path', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value) paths.push(resolve(cwd, value));
  }
  const pattern = input.pattern;
  // Grep's pattern is a regex; only Glob's pattern names paths.
  if (
    toolName === 'Glob' &&
    typeof pattern === 'string' &&
    isAbsolute(pattern)
  ) {
    const fixed = pattern.split(GLOB_CHAR)[0];
    paths.push(fixed.endsWith(sep) ? fixed : dirname(fixed));
  }
  return paths.length ? paths : [cwd];
}

/**
 * Resolves symlinks even for a path that doesn't exist yet (a file about to be
 * written): the nearest existing ancestor is resolved and the rest appended,
 * so a new file under a symlinked folder is placed where it would really land.
 */
async function realTarget(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Why a file tool call must be denied, or null when everything it touches stays
 * inside `cwd` (symlinks followed, so a link inside can't point outside).
 */
export async function pathViolation(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  for (const path of toolPaths(cwd, toolName, input)) {
    let real: string;
    try {
      real = await realTarget(path);
    } catch {
      // Fail closed: a path that can't be resolved is not let through.
      return 'Impossibile verificare il path richiesto';
    }
    if (!isInside(cwd, real)) {
      return 'Puoi accedere solo ai file della cartella di lavoro';
    }
  }
  return null;
}

/** Subfolders of a workspace folder, for the path picker (hidden ones left out). */
export async function listFolders(path: string, root: string) {
  const entries = await readdir(path, { withFileTypes: true });
  return {
    path,
    root,
    parent: path === root ? null : dirname(path),
    folders: entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b)),
  };
}
