/**
 * JSModuleIndexer - плагин для индексации JavaScript/TypeScript модулей
 * Строит дерево зависимостей от entrypoint через DFS (как в file2host.js)
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { createHash } from 'crypto';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
// @ts-expect-error - no type declarations for node-source-walk
import Walker from 'node-source-walk';
import { NodeFactory } from '../../core/NodeFactory.js';

/**
 * Manifest with service info
 */
interface IndexerManifest {
  projectPath: string;
  service: {
    id: string;
    name: string;
    path: string;
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

  constructor() {
    super();
    this.walker = new Walker();
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
   * Резолвит путь к модулю (добавляет .js/.ts если нужно)
   */
  private resolveModulePath(path: string): string {
    if (existsSync(path)) return path;
    // Try JavaScript extensions
    if (existsSync(path + '.js')) return path + '.js';
    if (existsSync(path + '.mjs')) return path + '.mjs';
    if (existsSync(path + '.jsx')) return path + '.jsx';
    // Try TypeScript extensions
    if (existsSync(path + '.ts')) return path + '.ts';
    if (existsSync(path + '.tsx')) return path + '.tsx';
    // Try index files
    if (existsSync(join(path, 'index.js'))) return join(path, 'index.js');
    if (existsSync(join(path, 'index.ts'))) return join(path, 'index.ts');
    if (existsSync(join(path, 'index.mjs'))) return join(path, 'index.mjs');
    if (existsSync(join(path, 'index.tsx'))) return join(path, 'index.tsx');
    return path;
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    try {
      const { graph, onProgress, config } = context;
      const manifest = context.manifest as IndexerManifest | undefined;
      const projectPath = manifest?.projectPath ?? '';
      const service = manifest?.service ?? { id: '', name: '', path: '' };

      // Check config for test file marking
      if ((config as { analysis?: { tests?: { markTestFiles?: boolean } } })?.analysis?.tests?.markTestFiles === false) {
        this.markTestFiles = false;
      }

      const entrypoint = service.path;
      // const pkgPath = join(projectPath, 'pkg');

      // Резолвим entrypoint относительно projectPath
      const absoluteEntrypoint = entrypoint.startsWith('/')
        ? entrypoint
        : join(projectPath, entrypoint);

      console.log(`[JSModuleIndexer] Building dependency tree from ${service.name}`);

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

        console.log(`[JSModuleIndexer] Processing: ${currentFile.replace(projectPath, '')} (depth ${depth})`);

        if (depth > MAX_DEPTH) {
          console.log(`[JSModuleIndexer] Max depth ${MAX_DEPTH} reached at ${currentFile}`);
          continue;
        }

        // Парсим зависимости
        const deps = this.processFile(currentFile, projectPath);
        console.log(`[JSModuleIndexer] Found ${deps instanceof Error ? 0 : deps.length} dependencies in ${currentFile.replace(projectPath, '')}`);

        if (deps instanceof Error) {
          if (!deps.message.includes('ENOENT')) {
            console.log(`[JSModuleIndexer] Error parsing ${currentFile}: ${deps.message}`);
          }
          continue;
        }

        // Создаём MODULE ноду для текущего файла
        const fileHash = this.calculateFileHash(currentFile);
        const moduleId = `MODULE:${fileHash}`; // StableID-based for deduplication

        // Используем NodeFactory для создания MODULE ноды
        // ВСЕГДА создаём ноду в графе (граф может быть пустой после force)
        const isTest = this.isTestFile(currentFile);
        const moduleNode = NodeFactory.createModule(currentFile, projectPath, {
          contentHash: fileHash ?? undefined,
          isTest
        });

        console.log(`[JSModuleIndexer] Creating MODULE node: ${moduleNode.id}`);
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
            console.log(`[JSModuleIndexer]   Skipping npm package: ${dep}`);
            continue;
          }

          const resolvedDep = this.resolveModulePath(dep);
          console.log(`[JSModuleIndexer]   Resolved: ${dep} -> ${resolvedDep.replace(projectPath, '')}`);

          // Добавляем в стек если ещё не посещали
          if (!visited.has(resolvedDep)) {
            visited.add(resolvedDep);
            stack.push({ file: resolvedDep, depth: depth + 1 });
            console.log(`[JSModuleIndexer]   Added to stack (depth ${depth + 1})`);
          } else {
            console.log(`[JSModuleIndexer]   Already visited, skipping`);
          }

          // Queue DEPENDS_ON edges for later (after all nodes exist)
          const depHash = this.calculateFileHash(resolvedDep);
          const depModuleId = `MODULE:${depHash}`;
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
        console.warn(`[JSModuleIndexer] ⚠️  ${service.name} hit MAX_MODULES limit (${MAX_MODULES})!`);
        console.warn(`[JSModuleIndexer]    This service may be pulling in too many dependencies.`);
        console.warn(`[JSModuleIndexer]    Unprocessed files in stack: ${stack.length}`);
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

      console.log(`[JSModuleIndexer] ${service.name}: ${nodesCreated} modules, ${visited.size} total in tree`);

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { totalModules: visited.size }
      );

    } catch (error) {
      console.error(`[JSModuleIndexer] Error:`, error);
      return createErrorResult(error as Error);
    }
  }
}
