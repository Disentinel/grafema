/**
 * ManifestResolver — resolves cross-package imports via manifest.yaml files.
 *
 * Given an import like `import { GraphBackend } from '@grafema/util'`,
 * the resolver loads @grafema/util's manifest.yaml and returns the
 * ManifestExport entry for GraphBackend (kind, effects, semanticId).
 *
 * This is the read-side complement to ManifestGenerator (write-side).
 *
 * Usage:
 *   const resolver = new ManifestResolver();
 *   resolver.loadFromWorkspace('/project', ['packages/util', 'packages/types']);
 *   resolver.loadFromNodeModules('/project/node_modules');
 *
 *   const result = resolver.resolve('@grafema/util', 'GraphBackend');
 *   // → { name: 'GraphBackend', kind: 'CLASS', effects: ['PURE'], semanticId: '...' }
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { Manifest, ManifestExport } from './types.js';
import type { RegistryIndex } from './registry.js';

export interface ResolveResult {
  /** The matched export entry */
  export: ManifestExport;
  /** Package purl this export belongs to */
  packagePurl: string;
  /** Confidence of the source manifest */
  confidence: number;
  /** Whether the manifest has a full graph available */
  hasGraph: boolean;
}

export class ManifestResolver {
  /** package name → loaded Manifest */
  private manifests = new Map<string, Manifest>();
  /** package name → Map<export name → ManifestExport> (index for O(1) lookup) */
  private exportIndex = new Map<string, Map<string, ManifestExport>>();

  /** Number of loaded manifests */
  get size(): number {
    return this.manifests.size;
  }

  /** All loaded package names */
  get packages(): string[] {
    return [...this.manifests.keys()];
  }

  /**
   * Load a single manifest from a YAML file path.
   * The package name is extracted from the manifest's purl field.
   */
  loadFromFile(filePath: string): Manifest | null {
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      const manifest = parseYaml(raw) as Manifest;
      if (!manifest?.package?.purl || !manifest.exports) return null;

      const pkgName = purlToPackageName(manifest.package.purl);
      this.register(pkgName, manifest);
      return manifest;
    } catch {
      return null;
    }
  }

  /**
   * Load manifests from workspace packages.
   * Scans each directory for manifest.yaml.
   *
   * @param rootDir Project root directory
   * @param packageDirs Relative paths to package directories (e.g., ['packages/util', 'packages/types'])
   */
  loadFromWorkspace(rootDir: string, packageDirs: string[]): number {
    let loaded = 0;
    for (const dir of packageDirs) {
      const manifestPath = join(rootDir, dir, 'manifest.yaml');
      if (this.loadFromFile(manifestPath)) loaded++;
    }
    return loaded;
  }

  /**
   * Auto-discover and load manifests from node_modules.
   * Scans node_modules for packages containing manifest.yaml.
   * Optionally scoped to specific package names.
   *
   * @param nodeModulesDir Path to node_modules directory
   * @param packageNames Optional list of package names to load (e.g., ['@grafema/util']). If omitted, scans all.
   */
  loadFromNodeModules(nodeModulesDir: string, packageNames?: string[]): number {
    if (!existsSync(nodeModulesDir)) return 0;

    let loaded = 0;
    if (packageNames) {
      for (const name of packageNames) {
        const manifestPath = join(nodeModulesDir, name, 'manifest.yaml');
        if (this.loadFromFile(manifestPath)) loaded++;
      }
    }
    return loaded;
  }

  /**
   * Load manifests from a registry directory (registry/index.yaml).
   * Reads index.yaml to discover available packages, then loads each manifest.
   *
   * @param registryDir Path to the registry directory containing index.yaml
   * @param packageNames Optional filter — only load these packages
   * @returns Number of manifests loaded
   */
  loadFromRegistry(registryDir: string, packageNames?: string[]): number {
    const indexPath = join(registryDir, 'index.yaml');
    if (!existsSync(indexPath)) return 0;

    let index: RegistryIndex;
    try {
      index = parseYaml(readFileSync(indexPath, 'utf-8')) as RegistryIndex;
    } catch {
      return 0;
    }

    if (!index?.entries) return 0;

    let loaded = 0;
    for (const entry of index.entries) {
      if (packageNames && !packageNames.includes(entry.name)) continue;

      const manifestPath = join(registryDir, entry.name, entry.version, 'manifest.yaml');
      if (this.loadFromFile(manifestPath)) loaded++;
    }

    return loaded;
  }

  /**
   * Register a manifest directly (e.g., from in-memory generation).
   */
  register(packageName: string, manifest: Manifest): void {
    this.manifests.set(packageName, manifest);

    // Build export index
    const index = new Map<string, ManifestExport>();
    for (const exp of manifest.exports) {
      index.set(exp.name, exp);
    }
    this.exportIndex.set(packageName, index);
  }

  /**
   * Resolve an import: given package name and symbol, return the export info.
   *
   * @param source Import source (e.g., '@grafema/util', 'graphql-yoga')
   * @param symbolName Exported symbol name (e.g., 'GraphBackend')
   * @returns ResolveResult or null if not found
   */
  resolve(source: string, symbolName: string): ResolveResult | null {
    const index = this.exportIndex.get(source);
    if (!index) return null;

    const exp = index.get(symbolName);
    if (!exp) return null;

    const manifest = this.manifests.get(source)!;
    return {
      export: exp,
      packagePurl: manifest.package.purl,
      confidence: manifest.confidence,
      hasGraph: manifest.capabilities.has_graph,
    };
  }

  /**
   * Resolve all symbols from a specific import source.
   * Returns a map of symbol name → ManifestExport for all known exports.
   *
   * Useful for: `import * as utils from '@grafema/util'`
   */
  resolveAll(source: string): Map<string, ManifestExport> | null {
    return this.exportIndex.get(source) ?? null;
  }

  /**
   * Get the full manifest for a package.
   */
  getManifest(packageName: string): Manifest | null {
    return this.manifests.get(packageName) ?? null;
  }

  /**
   * Check if a package has a loaded manifest.
   */
  has(packageName: string): boolean {
    return this.manifests.has(packageName);
  }

  /**
   * Get the effects for an imported symbol.
   * Shorthand for resolve() when you only need effects.
   */
  getEffects(source: string, symbolName: string): string[] | null {
    return this.resolve(source, symbolName)?.export.effects ?? null;
  }

  /**
   * Build a dependency graph from loaded manifests.
   * Returns: Map<packageName → Set<dependencyPackageName>>
   */
  buildDependencyGraph(): Map<string, Set<string>> {
    const deps = new Map<string, Set<string>>();

    for (const [name, manifest] of this.manifests) {
      const pkgDeps = new Set<string>();
      for (const imp of manifest.imports) {
        const depName = purlToPackageName(imp.purl);
        if (depName && this.manifests.has(depName)) {
          pkgDeps.add(depName);
        }
      }
      deps.set(name, pkgDeps);
    }

    return deps;
  }

  /**
   * Get summary stats for all loaded manifests.
   */
  getSummary(): ManifestSummary[] {
    const summaries: ManifestSummary[] = [];
    for (const [name, manifest] of this.manifests) {
      summaries.push({
        packageName: name,
        purl: manifest.package.purl,
        totalExports: manifest.exports.length,
        totalImports: manifest.imports.length,
        confidence: manifest.confidence,
        hasGraph: manifest.capabilities.has_graph,
        exportsByKind: countByKind(manifest.exports),
      });
    }
    return summaries.sort((a, b) => a.packageName.localeCompare(b.packageName));
  }
}

export interface ManifestSummary {
  packageName: string;
  purl: string;
  totalExports: number;
  totalImports: number;
  confidence: number;
  hasGraph: boolean;
  exportsByKind: Record<string, number>;
}

// ── Helpers ──────────────────────────────────────────────

/** Extract npm package name from a purl like "pkg:npm/@grafema/util@0.2.0" */
function purlToPackageName(purl: string): string {
  // pkg:npm/@scope/name@version or pkg:npm/name@version
  const match = purl.match(/^pkg:npm\/(.+?)(?:@[\d.]+.*)?$/);
  if (!match) return purl;

  const name = match[1];
  // For node builtins like "pkg:npm/node@*#fs", skip
  if (name === 'node') return '';
  return name;
}

function countByKind(exports: ManifestExport[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of exports) {
    counts[e.kind] = (counts[e.kind] || 0) + 1;
  }
  return counts;
}
