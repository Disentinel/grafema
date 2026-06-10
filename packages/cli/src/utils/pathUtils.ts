/**
 * Convert a node file path to relative display format.
 * Handles both legacy absolute paths and new relative paths (REG-408).
 */
import { relative, isAbsolute, resolve } from 'path';
import { realpathSync } from 'fs';

export function toRelativeDisplay(file: string, projectPath: string): string {
  return isAbsolute(file) ? relative(projectPath, file) : file;
}

/**
 * Resolve a command's `--project` option to an absolute, realpath'd project root.
 *
 * realpath matters because a symlinked root (e.g. macOS `/tmp` -> `/private/tmp`)
 * otherwise breaks `relative()` against the realpath'd file paths the graph stores,
 * making files read as NOT_ANALYZED. If the directory does not exist, the plain
 * resolved path is returned — the caller's dbPath check reports the missing project.
 *
 * @param projectOption - the raw `--project` value (e.g. ".")
 * @returns absolute project root, realpath'd when the directory exists
 */
export function resolveProjectRoot(projectOption: string): string {
  const resolved = resolve(projectOption);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
