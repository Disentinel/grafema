/**
 * Resolve a node's file path to an absolute path.
 *
 * After REG-408, node.file stores paths relative to projectPath.
 * This utility resolves them back to absolute for file system access.
 * Also handles legacy absolute paths for backward compatibility.
 *
 * @param nodeFile - The file field from a graph node (relative or absolute)
 * @param projectPath - The absolute project root path
 * @returns Absolute file path
 */

import { isAbsolute, join } from 'path';

export function resolveNodeFile(nodeFile: string, projectPath: string): string {
  if (isAbsolute(nodeFile)) return nodeFile;
  return join(projectPath, nodeFile);
}
