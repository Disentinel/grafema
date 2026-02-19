/**
 * PackageCoverageValidator -- creates ISSUE nodes for external packages
 * that are imported but have no semantic analyzer configured (REG-259).
 *
 * Reads the 'coverage:packages' resource from ResourceRegistry (populated
 * by Orchestrator from plugin metadata `covers` fields) and compares
 * against all IMPORT nodes with non-relative, non-builtin sources.
 *
 * Creates ONE issue:coverage ISSUE node per unique uncovered package
 * (not per file or per import).
 *
 * Phase: VALIDATION
 */

import { builtinModules } from 'module';
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { Resource } from '@grafema/types';

/** Resource ID for the covered packages set. */
export const COVERED_PACKAGES_RESOURCE_ID = 'coverage:packages';

/**
 * Resource containing the set of package names covered by semantic analyzers.
 * Populated by Orchestrator before the VALIDATION phase.
 */
export interface CoveredPackagesResource extends Resource {
  readonly id: typeof COVERED_PACKAGES_RESOURCE_ID;
  readonly packages: ReadonlySet<string>;
}

/** Factory for creating an empty CoveredPackagesResource. */
export function createCoveredPackagesResource(packages: Set<string>): CoveredPackagesResource {
  return {
    id: COVERED_PACKAGES_RESOURCE_ID,
    packages,
  };
}

/** Set of Node.js builtin module names (without 'node:' prefix). */
const NODE_BUILTINS = new Set(builtinModules);

/**
 * Check if an import source is a relative path (starts with . or /).
 */
function isRelativeImport(source: string): boolean {
  return source.startsWith('.') || source.startsWith('/');
}

/**
 * Check if an import source is a Node.js builtin module.
 * Handles the 'node:' prefix and subpath imports like 'fs/promises'.
 */
function isBuiltinModule(source: string): boolean {
  if (source.startsWith('node:')) {
    return true;
  }
  // Handle subpath imports like 'fs/promises' -> check 'fs'
  const baseModule = source.split('/')[0];
  return NODE_BUILTINS.has(baseModule);
}

/**
 * Extract the package name from an import source.
 * Handles scoped packages (@scope/pkg) and subpath imports (lodash/map).
 *
 * Examples:
 *   'lodash'          -> 'lodash'
 *   'lodash/map'      -> 'lodash'
 *   '@prisma/client'  -> '@prisma/client'
 *   '@scope/pkg/util' -> '@scope/pkg'
 */
function extractPackageName(source: string): string {
  if (source.startsWith('@')) {
    // Scoped package: @scope/pkg or @scope/pkg/subpath
    const parts = source.split('/');
    // Package name is @scope/pkg (first two parts)
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
  }
  // Regular package: pkg or pkg/subpath
  return source.split('/')[0];
}

export class PackageCoverageValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'PackageCoverageValidator',
      phase: 'VALIDATION',
      dependencies: [],
      creates: {
        nodes: ['ISSUE'],
        edges: ['AFFECTS'],
      },
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    // Get covered packages from ResourceRegistry
    const resource = context.resources?.get<CoveredPackagesResource>(COVERED_PACKAGES_RESOURCE_ID);
    const coveredPackages = resource?.packages ?? new Set<string>();

    logger.info('Starting package coverage check', {
      coveredPackages: coveredPackages.size,
    });

    // Collect all external packages and track uncovered ones
    const importedPackageNames = new Set<string>();
    const uncoveredPackages = new Map<string, { file: string; line: number }>();

    let importsScanned = 0;
    for await (const node of graph.queryNodes({ type: 'IMPORT' })) {
      importsScanned++;
      if (onProgress && importsScanned % 500 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'PackageCoverageValidator',
          message: `Scanning package imports: ${importsScanned}`,
          processedFiles: importsScanned,
        });
      }

      const source = (node as unknown as { source?: string }).source;
      if (!source) continue;

      // Skip relative imports
      if (isRelativeImport(source)) continue;

      // Skip Node.js builtins
      if (isBuiltinModule(source)) continue;

      const packageName = extractPackageName(source);
      importedPackageNames.add(packageName);

      // Skip if already covered by a semantic analyzer
      if (coveredPackages.has(packageName)) continue;

      // Track first occurrence for the issue location
      if (!uncoveredPackages.has(packageName)) {
        uncoveredPackages.set(packageName, {
          file: node.file || '',
          line: node.line || 0,
        });
      }
    }

    // Report one issue per unique uncovered package
    let issueCount = 0;

    for (const [packageName, location] of uncoveredPackages) {
      if (context.reportIssue) {
        await context.reportIssue({
          category: 'coverage',
          severity: 'warning',
          message: `Package '${packageName}' is imported but no semantic analyzer is configured for it`,
          file: location.file,
          line: location.line,
          context: {
            type: 'UNCOVERED_PACKAGE',
            packageName,
          },
        });
        issueCount++;
      }
    }

    const coveredCount = [...importedPackageNames].filter(p => coveredPackages.has(p)).length;

    const summary = {
      importedPackages: importedPackageNames.size,
      coveredPackages: coveredCount,
      uncoveredPackages: uncoveredPackages.size,
      issuesCreated: issueCount,
    };

    if (uncoveredPackages.size > 0) {
      logger.info('Uncovered packages found', {
        count: uncoveredPackages.size,
        packages: [...uncoveredPackages.keys()],
      });
    } else {
      logger.info('All external packages are covered');
    }

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      { summary }
    );
  }
}
