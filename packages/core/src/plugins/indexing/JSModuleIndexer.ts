/**
 * JSModuleIndexer - плагин для индексации JavaScript/TypeScript модулей
 * Строит дерево зависимостей от entrypoint через DFS (как в file2host.js)
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname, relative, basename } from 'path';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { Plugin, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
// @ts-expect-error - no type declarations for node-source-walk
import Walker from 'node-source-walk';
import { NodeFactory } from '../../core/NodeFactory.js';
import { LanguageError } from '../../errors/GrafemaError.js';
import { resolveModulePath as resolveModulePathUtil } from '../../utils/moduleResolution.js';

/**
 * Manifest with service info
 */
interface IndexerManifest {
  projectPath: string;
  service: {
    id: string;
    name: string;
    path: string;
    metadata?: {
      entrypoint?: string;
      [key: string]: unknown;
    };
  };
}

// Test file patterns (can be overridden in config)
const DEFAULT_TEST_PATTERNS: RegExp[] = [
  /[/\\]test[/\\]/,           // /test/
  /[/\\]tests[/\\]/,          // /tests/
  /[/\\]__tests__[/\\]/,      // /__tests__/
  /[/\\]spec[/\\]/,           // /spec/
  /\.test\.[jt]sx?$/,         // .test.js, .test.ts, .test.jsx, .test.tsx
  /\.spec\.[jt]sx?$/,         // .spec.js, .spec.ts, .spec.jsx, .spec.tsx
  /_test\.[jt]sx?$/,          // _test.js (Go-style)
  /[/\\]fixtures?[/\\]/,      // /fixture/ or /fixtures/
];

/**
 * Stack item for DFS traversal
 */
interface StackItem {
  file: string;
  depth: number;
}

/**
 * Edge to add
 */
interface EdgeToAdd {
  src: string;
  dst: string;
  type: string;
  etype?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * AST node types from walker
 */
interface ASTNode {
  type: string;
  callee?: { name?: string };
  source?: { type: string; value?: string; name?: string };
  arguments?: Array<{ type: string; value?: string; name?: string }>;
}

export class JSModuleIndexer extends Plugin {
  private walker: Walker;
  private cache: Map<string, string[] | Error>;
  private testPatterns: RegExp[];
  private markTestFiles: boolean;
  // Include/exclude pattern filtering (REG-185)
  private includePatterns?: string[];
  private excludePatterns?: string[];
  private projectPath: string = '';

  constructor() {
    super();
    this.walker = new Walker({
      plugins: ['jsx', 'typescript']
    });
    this.cache = new Map(); // Кеш зависимостей файла
    this.testPatterns = DEFAULT_TEST_PATTERNS;
    this.markTestFiles = true; // Default: enabled
  }

  /**
   * Check if file is a test file based on path patterns
   */
  private isTestFile(filePath: string): boolean {
    if (!this.markTestFiles) return false;
    return this.testPatterns.some(pattern => pattern.test(filePath));
  }

  /**
   * Check if a file should be skipped based on include/exclude patterns.
   *
   * Logic:
   * 1. If file matches any exclude pattern -> SKIP
   * 2. If include patterns specified AND file doesn't match any -> SKIP
   * 3. Otherwise -> PROCESS
   *
   * @param absolutePath - Absolute path to the file
   * @returns true if file should be skipped, false if it should be processed
   */
  private shouldSkipFile(absolutePath: string): boolean {
    // Normalize to relative path for pattern matching
    const relativePath = relative(this.projectPath, absolutePath).replace(/\\/g, '/');

    // Check exclude patterns first (if any match, skip)
    if (this.excludePatterns && this.excludePatterns.length > 0) {
      for (const pattern of this.excludePatterns) {
        if (minimatch(relativePath, pattern, { dot: true })) {
          return true;  // Excluded
        }
      }
    }

    // Check include patterns (if specified, file must match at least one)
    if (this.includePatterns && this.includePatterns.length > 0) {
      for (const pattern of this.includePatterns) {
        if (minimatch(relativePath, pattern, { dot: true })) {
          return false;  // Included
        }
      }
      return true;  // Include specified but file didn't match any
    }

    return false;  // No filtering, process file
  }

  get metadata(): PluginMetadata {
    return {
      name: 'JSModuleIndexer',
      phase: 'INDEXING',
      priority: 90,
      creates: {
        nodes: ['MODULE'],
        edges: ['CONTAINS', 'DEPENDS_ON']
      }
    };
  }

  private calculateFileHash(filePath: string): string | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Парсит файл и извлекает все зависимости:
   * - require('...')
   * - import ... from '...'
   * - export * from '...'
   * - export { ... } from '...'
   */
  private processFile(filePath: string, _projectPath: string): string[] | Error {
    if (this.cache.has(filePath)) {
      return this.cache.get(filePath)!;
    }

    const result: string[] = [];
    let content: string;
    let ast: unknown;

    try {
      if (!existsSync(filePath)) {
        this.cache.set(filePath, new Error('ENOENT'));
        return new Error('ENOENT');
      }

      content = readFileSync(filePath, 'utf-8');
      ast = this.walker.parse(content);
    } catch (e) {
      if (filePath.endsWith('.json')) {
        this.cache.set(filePath, []);
        return [];
      }
      this.cache.set(filePath, new Error((e as Error).message));
      return new Error((e as Error).message);
    }

    this.walker.traverse(ast, (node: ASTNode) => {
      const isRequire = node.type === 'CallExpression' && node.callee?.name === 'require';
      const isImport = node.type === 'ImportDeclaration';
      // export * from './module.js'
      const isExportAll = node.type === 'ExportAllDeclaration';
      // export { foo } from './module.js'
      const isExportNamed = node.type === 'ExportNamedDeclaration' && node.source;

      if (!isRequire && !isImport && !isExportAll && !isExportNamed) {
        return;
      }

      let source: { type: string; value?: string; name?: string } | undefined;
      if (isImport || isExportAll || isExportNamed) {
        source = node.source;
      } else {
        source = node.arguments?.[0];
      }
      if (!source || !['Identifier', 'StringLiteral'].includes(source.type)) {
        return;
      }

      const name = source.value || source.name;
      if (!name) return;

      // Игнорируем встроенные модули
      if (name.startsWith('internal/')) {
        return;
      }

      // Резолвим относительные пути
      if (name.startsWith('.') || name.startsWith('/')) {
        const dir = dirname(filePath);
        const resolved = resolve(dir, name);
        result.push(resolved);
      } else {
        // npm пакет - помечаем специально
        result.push(`package::${name}`);
      }
    });

    this.cache.set(filePath, result);
    return result;
  }

  /**
   * Resolve module path (adds .js/.ts if needed).
   * Uses shared utility from moduleResolution.ts (REG-320).
   * Falls back to original path if not found (preserves original behavior).
   */
  private resolveModulePath(path: string): string {
    return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    try {
      const { graph, onProgress, config } = context;
      const manifest = context.manifest as IndexerManifest | undefined;
      const projectPath = manifest?.projectPath ?? '';
      const service = manifest?.service ?? { id: '', name: '', path: '' };

      // Collect parse errors to report (REG-147)
      const parseErrors: Error[] = [];

      // Store projectPath for shouldSkipFile()
      this.projectPath = projectPath;

      // Read include/exclude patterns from config (REG-185)
      const orchConfig = config as { include?: string[]; exclude?: string[] } | undefined;
      this.includePatterns = orchConfig?.include;
      this.excludePatterns = orchConfig?.exclude;

      // Log if patterns are configured
      if (this.includePatterns || this.excludePatterns) {
        logger.info('File filtering enabled', {
          include: this.includePatterns?.length ?? 0,
          exclude: this.excludePatterns?.length ?? 0,
        });
      }

      // Check config for test file marking
      if ((config as { analysis?: { tests?: { markTestFiles?: boolean } } })?.analysis?.tests?.markTestFiles === false) {
        this.markTestFiles = false;
      }

      // Use metadata.entrypoint if available (from config services), otherwise fall back to path
      const entrypoint = service.metadata?.entrypoint || service.path;

      // Резолвим entrypoint относительно projectPath
      const absoluteEntrypoint = entrypoint.startsWith('/')
        ? entrypoint
        : join(projectPath, entrypoint);

      logger.info('Building dependency tree', { service: service.name });

      // DFS через стек (как в file2host.js)
      const visited = new Set<string>();
      const stack: StackItem[] = [{ file: absoluteEntrypoint, depth: 0 }];
      visited.add(absoluteEntrypoint);

      let nodesCreated = 0;
      let edgesCreated = 0;
      // const skipped = 0;

      const MAX_MODULES = 2000; // Safety limit per service
      const MAX_DEPTH = 50;      // Max dependency depth

      // Collect DEPENDS_ON edges to create after all nodes exist
      const pendingDependsOnEdges: EdgeToAdd[] = [];
      let lastProgressReport = 0;
      const PROGRESS_INTERVAL = 10; // Report every N files

      while (stack.length > 0 && visited.size < MAX_MODULES) {
        const { file: currentFile, depth } = stack.pop()!;

        // Check if file should be skipped based on include/exclude patterns (REG-185)
        if (this.shouldSkipFile(currentFile)) {
          logger.debug('Skipping file (filtered by patterns)', {
            file: currentFile.replace(projectPath, '')
          });
          continue;  // Don't process, don't follow imports
        }

        // Report progress every PROGRESS_INTERVAL files
        if (onProgress && visited.size - lastProgressReport >= PROGRESS_INTERVAL) {
          onProgress({
            phase: 'indexing',
            currentPlugin: 'JSModuleIndexer',
            message: `${service.name}: indexed ${visited.size} files`,
            processedFiles: visited.size,
            currentService: service.name
          });
          lastProgressReport = visited.size;
        }

        logger.debug('Processing file', { file: currentFile.replace(projectPath, ''), depth });

        if (depth > MAX_DEPTH) {
          logger.warn('Max depth reached', { maxDepth: MAX_DEPTH, file: currentFile });
          continue;
        }

        // Парсим зависимости
        const deps = this.processFile(currentFile, projectPath);
        logger.debug('Found dependencies', { file: currentFile.replace(projectPath, ''), count: deps instanceof Error ? 0 : deps.length });

        if (deps instanceof Error) {
          if (!deps.message.includes('ENOENT')) {
            const relativePath = relative(projectPath, currentFile) || basename(currentFile);
            const error = new LanguageError(
              `Failed to parse ${relativePath}: ${deps.message}`,
              'ERR_PARSE_FAILURE',
              {
                filePath: currentFile,
                phase: 'INDEXING',
                plugin: 'JSModuleIndexer',
              },
              'Check file syntax or ensure the file is a supported JavaScript/TypeScript file'
            );
            parseErrors.push(error);
            logger.debug('Parse error', { file: currentFile, error: deps.message });
          }
          continue;
        }

        // Создаём MODULE ноду для текущего файла с semantic ID
        const fileHash = this.calculateFileHash(currentFile);
        const relativePath = relative(projectPath, currentFile) || basename(currentFile);
        const semanticId = `${relativePath}->global->MODULE->module`;

        // Construct MODULE node manually to preserve absolute file path for analyzers
        const isTest = this.isTestFile(currentFile);
        const moduleNode = {
          id: semanticId,
          type: 'MODULE' as const,
          name: relativePath,
          file: currentFile, // Keep absolute path for file reading in analyzers
          line: 0,
          contentHash: fileHash || '',
          isTest
        };
        const moduleId = moduleNode.id;

        logger.debug('Creating MODULE node', { moduleId: moduleNode.id });
        await graph.addNode(moduleNode);
        nodesCreated++;

        // Always create SERVICE -> CONTAINS -> MODULE edge (even if module exists)
        await graph.addEdge({
          src: service.id,
          dst: moduleId,
          type: 'CONTAINS',
          version: 'main'
        });
        // Обрабатываем зависимости
        for (const dep of deps) {
          if (dep.startsWith('package::')) {
            // npm пакет - игнорируем пока
            logger.debug('Skipping npm package', { package: dep });
            continue;
          }

          const resolvedDep = this.resolveModulePath(dep);
          logger.debug('Resolved dependency', { from: dep, to: resolvedDep.replace(projectPath, '') });

          // Добавляем в стек если ещё не посещали
          if (!visited.has(resolvedDep)) {
            visited.add(resolvedDep);
            stack.push({ file: resolvedDep, depth: depth + 1 });
            logger.debug('Added to stack', { depth: depth + 1 });
          } else {
            logger.debug('Already visited, skipping', { file: resolvedDep });
          }

          // Queue DEPENDS_ON edges for later (after all nodes exist)
          // Use semantic ID format for dependency reference
          const depRelativePath = relative(projectPath, resolvedDep) || basename(resolvedDep);
          const depModuleId = `${depRelativePath}->global->MODULE->module`;
          pendingDependsOnEdges.push({
            src: moduleId,
            dst: depModuleId,
            type: 'DEPENDS_ON',
            version: 'main'
          });
        }
      }

      // Create all DEPENDS_ON edges in one batch (faster than loop)
      if (pendingDependsOnEdges.length > 0) {
        await graph.addEdges(pendingDependsOnEdges);
        edgesCreated += pendingDependsOnEdges.length;
      }

      // Warning if hit MAX_MODULES limit
      if (visited.size >= MAX_MODULES) {
        logger.warn('Hit MAX_MODULES limit', {
          service: service.name,
          limit: MAX_MODULES,
          unprocessedInStack: stack.length
        });
      }

      // Final progress report
      if (onProgress) {
        onProgress({
          phase: 'indexing',
          currentPlugin: 'JSModuleIndexer',
          message: `${service.name}: indexed ${visited.size} files`,
          totalFiles: visited.size,
          processedFiles: visited.size,
          currentService: service.name
        });
      }

      logger.info('Indexing complete', {
        service: service.name,
        modulesCreated: nodesCreated,
        totalInTree: visited.size
      });

      // Return result with parse errors (REG-147)
      return {
        success: true,
        created: { nodes: nodesCreated, edges: edgesCreated },
        errors: parseErrors,
        warnings: [],
        metadata: { totalModules: visited.size },
      };

    } catch (error) {
      logger.error('Indexing failed', { error });
      return createErrorResult(error as Error);
    }
  }
}
