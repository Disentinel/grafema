/**
 * Grafema version constants.
 *
 * Reads version from @grafema/core package.json at module load time.
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
