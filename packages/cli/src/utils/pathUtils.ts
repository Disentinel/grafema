/**
 * Convert a node file path to relative display format.
 * Handles both legacy absolute paths and new relative paths (REG-408).
 */
import { relative, isAbsolute } from 'path';

export function toRelativeDisplay(file: string, projectPath: string): string {
  return isAbsolute(file) ? relative(projectPath, file) : file;
}
