/**
 * RustModuleIndexer - plugin for indexing Rust modules
 * Discovers .rs files in rust-engine/src/ directory
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, relative, basename, join } from 'path';
import { createHash } from 'crypto';
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';

// Test file patterns for Rust
const RUST_TEST_PATTERNS: RegExp[] = [
  /[/\\]tests[/\\]/,           // /tests/
  /_test\.rs$/,                // _test.rs
  /[/\\]test\.rs$/,            // test.rs in subdirectory
];

export class RustModuleIndexer extends Plugin {
  private testPatterns: RegExp[];

  constructor() {
    super();
    this.testPatterns = RUST_TEST_PATTERNS;
  }

  get metadata(): PluginMetadata {
    return {
      name: 'RustModuleIndexer',
      phase: 'INDEXING',
      priority: 85,  // After JSModuleIndexer (90)
      creates: {
        nodes: ['RUST_MODULE'],
        edges: ['CONTAINS']
      }
    };
  }

  /**
   * Check if file is a test file based on path patterns
   */
  private isTestFile(filePath: string): boolean {
    return this.testPatterns.some(pattern => pattern.test(filePath));
  }

  /**
   * Recursively find all .rs files in a directory
   */
  private findRustFiles(dir: string, files: string[] = []): string[] {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        // Skip target directory
        if (entry === 'target') continue;

        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            this.findRustFiles(fullPath, files);
          } else if (entry.endsWith('.rs')) {
            files.push(fullPath);
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // Skip directories we can't read
    }
    return files;
  }

  /**
   * Convert file path to Rust module name
   * src/ffi/napi_bindings.rs -> ffi::napi_bindings
   * src/lib.rs -> crate
   * src/ffi/mod.rs -> ffi
   */
  private pathToModuleName(relativePath: string): string {
    let name = relativePath
      .replace(/\.rs$/, '')
      .replace(/\//g, '::');

    if (name.endsWith('::mod')) {
      name = name.replace(/::mod$/, '');
    }
    if (name === 'lib') {
      name = 'crate';
    }
    return name;
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { manifest, graph, onProgress } = context;
    // Cast manifest to expected shape
    const typedManifest = manifest as { projectPath: string } | undefined;
    const { projectPath } = typedManifest!;

    // Find rust-engine/src directory
    const rustRoot = resolve(projectPath, 'rust-engine/src');

    if (!existsSync(rustRoot)) {
      logger.info('rust-engine/src not found, skipping');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true });
    }

    // Discover all .rs files recursively
    const rsFiles = this.findRustFiles(rustRoot);

    logger.info('Found Rust files', { count: rsFiles.length });

    let nodesCreated = 0;
    const errors: Array<{ file: string; error: string }> = [];

    for (const filePath of rsFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        const relativePath = relative(rustRoot, filePath);
        const moduleName = this.pathToModuleName(relativePath);

        const nodeId = `RUST_MODULE#${moduleName}#${filePath}`;

        await graph.addNode({
          id: nodeId,
          type: 'RUST_MODULE',
          name: moduleName,
          file: filePath,
          contentHash: hash,
          isLib: basename(filePath) === 'lib.rs',
          isMod: basename(filePath) === 'mod.rs',
          isTest: this.isTestFile(filePath)
        } as unknown as NodeRecord);

        nodesCreated++;

        if (onProgress && nodesCreated % 10 === 0) {
          onProgress({
            phase: 'indexing',
            currentPlugin: 'RustModuleIndexer',
            message: `Indexed ${nodesCreated}/${rsFiles.length} Rust modules`,
            totalFiles: rsFiles.length,
            processedFiles: nodesCreated
          });
        }
      } catch (err) {
        errors.push({ file: filePath, error: (err as Error).message });
      }
    }

    if (errors.length > 0) {
      logger.warn('Errors during indexing', { errorCount: errors.length });
    }

    logger.info('Rust modules indexed', { count: nodesCreated });
    return createSuccessResult({ nodes: nodesCreated, edges: 0 }, { errors: errors.length });
  }
}
