/**
 * CoverageAnalyzer - Calculates analysis coverage for a project
 *
 * Determines which files in a project have been analyzed and categorizes
 * files into three groups:
 * - Analyzed: Files that appear as MODULE nodes in the graph
 * - Unsupported: Files with extensions that no indexer can handle
 * - Unreachable: Files with supported extensions but not in the graph
 *
 * Usage:
 *   const analyzer = new CoverageAnalyzer(graphBackend, '/path/to/project');
 *   const result = await analyzer.analyze();
 */

import { readdirSync, existsSync, lstatSync } from 'fs';
import { join, relative, extname } from 'path';
import type { GraphBackend } from '@grafema/types';

/**
 * Supported file extensions by language
 */
const JS_SUPPORTED = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];
const RUST_SUPPORTED = ['.rs'];
const SUPPORTED_EXTENSIONS = new Set([...JS_SUPPORTED, ...RUST_SUPPORTED]);

/**
 * Known code file extensions (for scanning)
 * Files with these extensions are considered source code
 */
const CODE_EXTENSIONS = new Set([
  // Supported
  ...JS_SUPPORTED,
  ...RUST_SUPPORTED,
  // Unsupported but tracked
  '.go', '.kt', '.java', '.py', '.rb', '.php', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.swift', '.scala', '.sql', '.graphql', '.gql',
]);

/**
 * Directories to always skip during scanning
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.grafema',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '__pycache__',
  'target', // Rust
  'vendor',
]);

/**
 * Coverage analysis result
 */
export interface CoverageResult {
  projectPath: string;
  total: number;
  analyzed: {
    count: number;
    files: string[];
  };
  unsupported: {
    count: number;
    byExtension: Record<string, string[]>;
  };
  unreachable: {
    count: number;
    files: string[];
    byExtension: Record<string, string[]>;
  };
  percentages: {
    analyzed: number;
    unsupported: number;
    unreachable: number;
  };
}

/**
 * CoverageAnalyzer calculates what percentage of a codebase has been analyzed.
 */
export class CoverageAnalyzer {
  private graph: GraphBackend;
  private projectPath: string;

  constructor(graph: GraphBackend, projectPath: string) {
    this.graph = graph;
    this.projectPath = projectPath;
  }

  /**
   * Analyze the project and return coverage statistics
   */
  async analyze(): Promise<CoverageResult> {
    // Step 1: Get all MODULE nodes from the graph
    const analyzedFiles = await this.getAnalyzedFiles();
    const analyzedSet = new Set(analyzedFiles);

    // Step 2: Scan project for all code files
    const allCodeFiles = this.scanProjectFiles();

    // Step 3: Categorize files
    const unsupportedByExt: Record<string, string[]> = {};
    const unreachableByExt: Record<string, string[]> = {};
    const unreachableFiles: string[] = [];

    for (const file of allCodeFiles) {
      if (analyzedSet.has(file)) {
        continue; // Already analyzed
      }

      const ext = extname(file).toLowerCase();

      if (SUPPORTED_EXTENSIONS.has(ext)) {
        // Supported but not in graph = unreachable
        unreachableFiles.push(file);
        if (!unreachableByExt[ext]) {
          unreachableByExt[ext] = [];
        }
        unreachableByExt[ext].push(file);
      } else {
        // Not supported = unsupported
        if (!unsupportedByExt[ext]) {
          unsupportedByExt[ext] = [];
        }
        unsupportedByExt[ext].push(file);
      }
    }

    // Calculate counts
    const unsupportedCount = Object.values(unsupportedByExt)
      .reduce((sum, files) => sum + files.length, 0);
    const unreachableCount = unreachableFiles.length;
    const analyzedCount = analyzedFiles.length;
    const total = analyzedCount + unsupportedCount + unreachableCount;

    // Calculate percentages (handle division by zero)
    const percentages = {
      analyzed: total > 0 ? Math.round((analyzedCount / total) * 100) : 0,
      unsupported: total > 0 ? Math.round((unsupportedCount / total) * 100) : 0,
      unreachable: total > 0 ? Math.round((unreachableCount / total) * 100) : 0,
    };

    return {
      projectPath: this.projectPath,
      total,
      analyzed: {
        count: analyzedCount,
        files: analyzedFiles,
      },
      unsupported: {
        count: unsupportedCount,
        byExtension: unsupportedByExt,
      },
      unreachable: {
        count: unreachableCount,
        files: unreachableFiles,
        byExtension: unreachableByExt,
      },
      percentages,
    };
  }

  /**
   * Get list of analyzed files from the graph (MODULE nodes)
   */
  private async getAnalyzedFiles(): Promise<string[]> {
    const files: string[] = [];

    // Use queryNodes with type: 'MODULE'
    for await (const node of this.graph.queryNodes({ type: 'MODULE' })) {
      if (node.file) {
        // Store relative path for consistency
        const relativePath = node.file.startsWith(this.projectPath)
          ? relative(this.projectPath, node.file)
          : node.file;
        files.push(relativePath);
      }
    }

    return files;
  }

  /**
   * Scan project directory for all code files
   * Respects common ignore patterns (node_modules, .git, etc.)
   */
  private scanProjectFiles(): string[] {
    const files: string[] = [];
    this.walkDirectory(this.projectPath, files);
    return files;
  }

  /**
   * Recursively walk directory and collect code files
   */
  private walkDirectory(dir: string, files: string[], depth = 0): void {
    // Safety: limit recursion depth
    if (depth > 20) return;

    if (!existsSync(dir)) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // Skip directories we can't read
    }

    for (const entry of entries) {
      // Skip hidden files and directories
      if (entry.startsWith('.')) continue;

      // Skip known non-source directories
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);

      // Skip symlinks to avoid infinite loops
      try {
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;

        if (stat.isDirectory()) {
          this.walkDirectory(fullPath, files, depth + 1);
        } else if (stat.isFile()) {
          const ext = extname(entry).toLowerCase();
          if (CODE_EXTENSIONS.has(ext)) {
            // Store relative path
            files.push(relative(this.projectPath, fullPath));
          }
        }
      } catch {
        // Skip files we can't stat
        continue;
      }
    }
  }
}
