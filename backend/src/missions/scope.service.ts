import { Injectable } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import picomatch from 'picomatch';
import type { Plan } from './plan-schema.js';
import { GitService, type DiffEntry } from './git-service.js';

export type ScopeViolation =
  | { kind: 'dependency'; file: string; name: string }
  | { kind: 'migration'; file: string }
  | { kind: 'deleted'; file: string }
  | { kind: 'path'; file: string };

/** Manifest sections whose new entries must be in `scope.dependencies`. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

type Dependencies = Partial<
  Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
>;

const GLOB_MAGIC = /[*?[\]{}()!+@]/;

/** A `scope.paths` entry matches itself and everything below it. */
function matches(file: string, patterns: string[]) {
  return patterns.some((pattern) => {
    if (GLOB_MAGIC.test(pattern))
      return picomatch(pattern, { dot: true })(file);
    return (
      file === pattern || file.startsWith(`${pattern.replace(/\/+$/, '')}/`)
    );
  });
}

function dependencyNames(manifest: Dependencies) {
  const names = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  return names;
}

function parseManifest(text: string | null): Dependencies {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as Dependencies;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/**
 * The perimeter of the plan, checked without agents: new dependencies, new
 * migrations, deleted files, and files outside `scope.paths`.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly git: GitService) {}

  async check(
    worktree: string,
    base: string,
    scope: Plan['scope'],
  ): Promise<ScopeViolation[]> {
    const entries = await this.git.diff(worktree, base);
    const violations: ScopeViolation[] = [];
    const allowed = [...scope.paths, ...scope.tests];

    for (const entry of entries) {
      violations.push(
        ...(await this.dependencies(worktree, base, entry, scope)),
      );

      if (
        entry.status.startsWith('A') &&
        /(^|\/)migrations\//.test(entry.file)
      ) {
        if (!scope.migrations) {
          violations.push({ kind: 'migration', file: entry.file });
        }
      }

      if (entry.status === 'D') {
        violations.push({ kind: 'deleted', file: entry.file });
      }

      if (allowed.length && !matches(entry.file, allowed)) {
        violations.push({ kind: 'path', file: entry.file });
      }
      // A rename also removes its old path, which must be inside the perimeter too.
      if (entry.from && allowed.length && !matches(entry.from, allowed)) {
        violations.push({ kind: 'path', file: entry.from });
      }
    }

    return violations;
  }

  private async dependencies(
    worktree: string,
    base: string,
    entry: DiffEntry,
    scope: Plan['scope'],
  ): Promise<ScopeViolation[]> {
    if (entry.status === 'D' || basename(entry.file) !== 'package.json')
      return [];

    const before = parseManifest(
      await this.git.showFile(worktree, base, entry.from ?? entry.file),
    );
    const current = await readFile(join(worktree, entry.file), 'utf8').catch(
      () => null,
    );
    const after = parseManifest(current);

    const known = new Set(scope.dependencies);
    const beforeNames = dependencyNames(before);
    const added = [...dependencyNames(after)].filter(
      (name) => !beforeNames.has(name) && !known.has(name),
    );
    return added.map((name) => ({
      kind: 'dependency' as const,
      file: entry.file,
      name,
    }));
  }
}
