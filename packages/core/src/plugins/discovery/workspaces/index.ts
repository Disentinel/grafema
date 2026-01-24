/**
 * Workspace Detection and Resolution
 *
 * Exports utilities for detecting workspace types and resolving workspace packages.
 */

export {
  detectWorkspaceType,
  type WorkspaceType,
  type WorkspaceDetectionResult
} from './detector.js';

export {
  parsePnpmWorkspace,
  parseNpmWorkspace,
  parseLernaConfig,
  type WorkspaceConfig
} from './parsers.js';

export {
  resolveWorkspacePackages,
  type WorkspacePackage
} from './globResolver.js';
