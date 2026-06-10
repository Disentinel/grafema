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

import { readdirSync, existsSync, lstatSync, realpathSync } from 'fs';
import { join, relative, extname } from 'path';
import type { GraphBackend } from '@grafema/types';

/**
 * Supported file extensions by language.
 *
 * The JS/TS set MUST match the orchestrator's authoritative `is_js_ts_file`
 * (`packages/grafema-orchestrator/src/analyzer.rs`: `js | jsx | ts | tsx |
 * mjs | cjs | mts | cts`) — that function decides which files are indexed into
 * the graph as MODULE nodes. If this list omits an extension the orchestrator
 * indexes, an on-disk file of that extension that is NOT in the graph is never
 * scanned (see {@link CODE_EXTENSIONS} / `walkDirectory`), so it silently drops
 * out of `total` and the `unreachable` breakdown — inflating coverage %.
 */
const JS_SUPPORTED = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const RUST_SUPPORTED = ['.rs'];
const SUPPORTED_EXTENSIONS = new Set([...JS_SUPPORTED, ...RUST_SUPPORTED]);

/**
 * ISSUE node categories that mean the analyzer SKIPPED the file entirely, so it
 * contributed zero real analysis even though a MODULE stub exists for it
 * (the stub is created so file-scoped GC and graph queries still see the file).
 *
 * A file carrying one of these issues is reported as `failed`, not `analyzed`,
 * so the coverage percentage reflects real analysis (REG-1140). These are the
 * size-guard silent-skips emitted by the orchestrator
 * (`grafema-orchestrator/src/analyzer.rs`); recoverable `parse_error`s are
 * intentionally NOT here — oxc continues with a partial AST and still produces
 * real nodes, so those files remain legitimately "analyzed".
 */
const SKIP_ISSUE_CATEGORIES = new Set(['oversized_source', 'oversized_ast']);

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
  /**
   * Files that have a MODULE node but were skipped/failed during analysis
   * (e.g. oversized god-files) so they produced no real analysis. Subtracted
   * from `analyzed` so coverage is not inflated (REG-1140).
   */
  failed: {
    count: number;
    files: string[];
    byCategory: Record<string, string[]>;
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
    failed: number;
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

  /**
   * @param graph - graph backend to query for MODULE/ISSUE nodes
   * @param projectPath - absolute project root to scan and to strip from node
   *   paths. It is realpath'd here (REG-408 class): the graph stores realpath'd
   *   ABSOLUTE file paths, so a symlinked root (e.g. macOS `/tmp` ->
   *   `/private/tmp`) would otherwise never `startsWith` an absolute MODULE path
   *   — keeping the file absolute while {@link scanProjectFiles} emits relative
   *   paths, double-counting the same file as both `analyzed` and `unreachable`
   *   and inflating `total`. Callers (`grafema coverage`, MCP `get_coverage`)
   *   pass a raw `resolve()`'d / user-supplied root, so normalizing here fixes
   *   every caller in one place. Falls back to the given path if it does not
   *   exist on disk (the caller's own dbPath check reports a missing project).
   */
  constructor(graph: GraphBackend, projectPath: string) {
    this.graph = graph;
    let normalized = projectPath;
    try {
      normalized = realpathSync(projectPath);
    } catch {
      // Path does not exist (or is not resolvable): keep the raw value.
    }
    this.projectPath = normalized;
  }

  /**
   * Analyze the project and return coverage statistics
   */
  async analyze(): Promise<CoverageResult> {
    // Step 1: Get all MODULE nodes from the graph
    const allModuleFiles = await this.getAnalyzedFiles();

    // Step 1b: Identify files that have a MODULE node but were skipped/failed
    // during analysis (oversized god-files etc.). These contribute zero real
    // analysis and must not inflate the analyzed count (REG-1140).
    const failedByFile = await this.getSkippedFiles();
    const analyzedFiles: string[] = [];
    const failedFiles: string[] = [];
    const failedByCategory: Record<string, string[]> = {};
    for (const file of allModuleFiles) {
      const category = failedByFile.get(file);
      if (category) {
        failedFiles.push(file);
        if (!failedByCategory[category]) {
          failedByCategory[category] = [];
        }
        failedByCategory[category].push(file);
      } else {
        analyzedFiles.push(file);
      }
    }
    const analyzedSet = new Set(analyzedFiles);
    const failedSet = new Set(failedFiles);

    // Step 2: Scan project for all code files
    const allCodeFiles = this.scanProjectFiles();

    // Step 3: Categorize files
    const unsupportedByExt: Record<string, string[]> = {};
    const unreachableByExt: Record<string, string[]> = {};
    const unreachableFiles: string[] = [];

    for (const file of allCodeFiles) {
      if (analyzedSet.has(file) || failedSet.has(file)) {
        continue; // Already accounted for as analyzed or failed
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
    const failedCount = failedFiles.length;
    // `failed` files have MODULE nodes, so they were previously counted in
    // `analyzed`; the total file population is unchanged — failed is carved out
    // of analyzed, not added on top.
    const total = analyzedCount + failedCount + unsupportedCount + unreachableCount;

    // Calculate percentages (handle division by zero)
    const percentages = {
      analyzed: total > 0 ? Math.round((analyzedCount / total) * 100) : 0,
      failed: total > 0 ? Math.round((failedCount / total) * 100) : 0,
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
      failed: {
        count: failedCount,
        files: failedFiles,
        byCategory: failedByCategory,
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
   * Map of files the analyzer SKIPPED → the ISSUE category that flagged the skip.
   *
   * A skipped file still gets a MODULE stub (so it appears in {@link getAnalyzedFiles}),
   * but it produced no real analysis. We detect skips via ISSUE nodes whose
   * `category` is in {@link SKIP_ISSUE_CATEGORIES} (size-guard silent-skips). The
   * returned paths are normalized to project-relative form to match the MODULE
   * file paths from {@link getAnalyzedFiles}. Used to keep skipped files out of
   * the analyzed count (REG-1140).
   */
  private async getSkippedFiles(): Promise<Map<string, string>> {
    const skipped = new Map<string, string>();

    for await (const node of this.graph.queryNodes({ type: 'ISSUE' })) {
      const category = typeof node.category === 'string' ? node.category : '';
      if (!SKIP_ISSUE_CATEGORIES.has(category) || !node.file) {
        continue;
      }
      const relativePath = node.file.startsWith(this.projectPath)
        ? relative(this.projectPath, node.file)
        : node.file;
      // First skip-category issue per file wins (a file is skipped once).
      if (!skipped.has(relativePath)) {
        skipped.set(relativePath, category);
      }
    }

    return skipped;
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
