/**
 * Grafema version constants.
 *
 * Reads version from @grafema/util package.json at module load time.
 * This is the single source of truth for runtime version checks.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

/** Full Grafema version string (e.g., "0.2.5-beta") */
export const GRAFEMA_VERSION: string = pkg.version;

/**
 * Extract major.minor.patch from a version string, stripping pre-release tags.
 *
 * "0.2.5-beta" → "0.2.5"
 * "0.2.5" → "0.2.5"
 * "1.0.0-alpha.1" → "1.0.0"
 */
export function getSchemaVersion(version: string): string {
  // Strip pre-release tag (everything after first hyphen)
  const base = version.split('-')[0];
  return base;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a version string into structured major.minor.patch components.
 * Strips pre-release tags before parsing.
 *
 * @param version - Version string (e.g., "0.2.5-beta")
 * @returns Parsed version or null if the string is not a valid version
 */
export function parseVersion(version: string): ParsedVersion | null {
  const base = getSchemaVersion(version);
  const parts = base.split('.');
  if (parts.length < 2) return null;
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  const patch = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
  if (isNaN(major) || isNaN(minor) || isNaN(patch)) return null;
  return { major, minor, patch };
}

/**
 * Check if two versions are compatible (same major.minor).
 * Patch differences are allowed — only major or minor mismatch is incompatible.
 *
 * @param configVersion - Version from the config file
 * @param currentVersion - Currently running Grafema version
 * @returns true if versions share the same major.minor
 */
export function isCompatibleVersion(configVersion: string, currentVersion: string): boolean {
  const config = parseVersion(configVersion);
  const current = parseVersion(currentVersion);
  if (!config || !current) return false;
  return config.major === current.major && config.minor === current.minor;
}
