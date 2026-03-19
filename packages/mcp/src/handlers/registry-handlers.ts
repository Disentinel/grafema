/**
 * MCP Registry Handlers — query the local manifest registry.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { ManifestResolver } from '@grafema/util';
import { getProjectPath } from '../state.js';
import { textResult, errorResult } from '../utils.js';
import type { ToolResult, QueryRegistryArgs } from '../types.js';

/** Cached resolver instance — reloaded when index changes. */
let cachedResolver: ManifestResolver | null = null;
let cachedIndexMtime: number = 0;

function getRegistryDir(): string {
  return join(getProjectPath(), 'registry');
}

function getResolver(): ManifestResolver | null {
  const registryDir = getRegistryDir();
  const indexPath = join(registryDir, 'index.yaml');
  if (!existsSync(indexPath)) return null;

  // Check if index has changed since last load
  try {
    const { mtimeMs } = require('fs').statSync(indexPath);
    if (cachedResolver && mtimeMs === cachedIndexMtime) {
      return cachedResolver;
    }
    cachedIndexMtime = mtimeMs;
  } catch {
    return null;
  }

  const resolver = new ManifestResolver();
  const loaded = resolver.loadFromRegistry(registryDir);
  if (loaded === 0) return null;

  cachedResolver = resolver;
  return resolver;
}

export async function handleQueryRegistry(args: QueryRegistryArgs): Promise<ToolResult> {
  const resolver = getResolver();
  if (!resolver) {
    return errorResult(
      'No registry found. Run `grafema registry build --all` to build manifests for dependencies.',
    );
  }

  // No package specified → list all packages
  if (!args.package) {
    const summaries = resolver.getSummary();
    const lines = summaries.map(s =>
      `${s.packageName} (${s.totalExports} exports, confidence ${s.confidence.toFixed(2)}, ${s.hasGraph ? 'graph' : 'no graph'})`,
    );
    return textResult(
      `Registry: ${summaries.length} packages\n\n${lines.join('\n')}`,
    );
  }

  // Package specified but no symbol → show package details
  if (!args.symbol) {
    const manifest = resolver.getManifest(args.package);
    if (!manifest) {
      return errorResult(
        `Package "${args.package}" not found in registry. Available: ${resolver.packages.join(', ')}`,
      );
    }

    const exportList = manifest.exports.map(e =>
      `  ${e.name} (${e.kind}) → ${e.effects.join(', ')}`,
    );

    const header = [
      `Package: ${manifest.package.purl}`,
      `Source: ${manifest.package.source_type}`,
      `Confidence: ${manifest.confidence}`,
      `Exports: ${manifest.exports.length}`,
      `Imports: ${manifest.imports.length}`,
      `Has graph: ${manifest.capabilities.has_graph}`,
    ];

    const body = exportList.length > 0
      ? `\nExports:\n${exportList.join('\n')}`
      : '\nNo exports (source_type may be minified/bundled)';

    return textResult(header.join('\n') + body);
  }

  // Package + symbol → resolve specific export
  const result = resolver.resolve(args.package, args.symbol);
  if (!result) {
    // Check if package exists but symbol doesn't
    if (resolver.has(args.package)) {
      const allExports = resolver.resolveAll(args.package);
      const available = allExports ? [...allExports.keys()].slice(0, 20).join(', ') : '(none)';
      return errorResult(
        `Symbol "${args.symbol}" not found in ${args.package}. Available exports: ${available}`,
      );
    }
    return errorResult(`Package "${args.package}" not found in registry.`);
  }

  return textResult(
    [
      `${args.package}.${args.symbol}`,
      `  Kind: ${result.export.kind}`,
      `  Effects: ${result.export.effects.join(', ')}`,
      `  SemanticId: ${result.export.semanticId}`,
      `  Package: ${result.packagePurl}`,
      `  Confidence: ${result.confidence}`,
      result.export.params?.length
        ? `  Params: ${result.export.params.map(p => `${p.name}:${p.flow}`).join(', ')}`
        : null,
      result.export.returns ? `  Returns: ${result.export.returns.flow}` : null,
    ].filter(Boolean).join('\n'),
  );
}
