/**
 * RustAnalyzer - plugin for analyzing Rust source files
 * Uses syn parser via NAPI to extract functions, structs, impl blocks, traits
 * Detects #[napi] attributes for FFI linking
 */

import { readFileSync } from 'fs';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord, AnyBrandedNode } from '@grafema/types';
import { NodeFactory } from '../../core/NodeFactory.js';

/**
 * Rust function from parser
 */
interface RustFunction {
  name: string;
  line: number;
  column: number;
  isPub: boolean;
  isAsync: boolean;
  isUnsafe: boolean;
  isConst: boolean;
  isNapi: boolean;
  napiJsName?: string;
  napiConstructor?: boolean;
  napiGetter?: string;
  napiSetter?: string;
  params?: string[];
  returnType?: string;
  unsafeBlocks?: unknown[];
  calls?: RustCall[];
}

/**
 * Rust struct from parser
 */
interface RustStruct {
  name: string;
  line: number;
  isPub: boolean;
  isNapi: boolean;
  fields?: unknown[];
}

/**
 * Rust impl block from parser
 */
interface RustImpl {
  targetType: string;
  traitName?: string;
  line: number;
  methods: RustMethod[];
}

/**
 * Rust method from parser
 */
interface RustMethod {
  name: string;
  line: number;
  column: number;
  isPub: boolean;
  isAsync: boolean;
  isUnsafe: boolean;
  isConst: boolean;
  isNapi: boolean;
  napiJsName?: string;
  napiConstructor?: boolean;
  napiGetter?: string;
  napiSetter?: string;
  params?: string[];
  returnType?: string;
  selfType?: string;
  unsafeBlocks?: unknown[];
  calls?: RustCall[];
}

/**
 * Rust trait from parser
 */
interface RustTrait {
  name: string;
  line: number;
  isPub: boolean;
  methods?: Array<{
    name: string;
    params: string[];
    returnType: string;
  }>;
}

/**
 * Rust call from parser
 */
interface RustCall {
  line: number;
  column: number;
  callType: 'function' | 'method' | 'macro';
  name?: string;
  receiver?: string;
  method?: string;
  argsCount: number;
  sideEffect?: string;
}

/**
 * Parse result from native binding
 */
interface RustParseResult {
  functions: RustFunction[];
  structs: RustStruct[];
  impls: RustImpl[];
  traits: RustTrait[];
}

/**
 * Analysis stats
 */
interface AnalysisStats {
  functions: number;
  structs: number;
  impls: number;
  methods: number;
  traits: number;
  calls: number;
  edges: number;
}

/**
 * Edge to add
 */
interface EdgeToAdd {
  src: string;
  dst: string;
  type: string;
  [key: string]: unknown;
}

// NAPI binding - will be exported from packages/rfdb-server after build
// Loaded lazily on first execute() call to avoid top-level await (CJS compatibility)
let parseRustFile: ((code: string) => RustParseResult) | undefined;
let bindingLoaded = false;

/**
 * Load the native binding lazily on first use.
 * This avoids top-level await which breaks esbuild CJS bundling.
 */
async function loadNativeBinding(): Promise<void> {
  if (bindingLoaded) return;
  bindingLoaded = true;

  // Path: from dist/plugins/analysis/ go up 5 levels to reach project root, then packages/rfdb-server/
  try {
    const nativeBinding = await import('../../../../../packages/rfdb-server/grafema-graph-engine.node' as any);
    parseRustFile = nativeBinding.parseRustFile;
    return;
  } catch {
    // Dynamic import failed, try require fallback
  }

  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const nativeBinding = require('../../../../../packages/rfdb-server/grafema-graph-engine.node');
    parseRustFile = nativeBinding.parseRustFile;
  } catch {
    // Silent - will be reported during execute if needed
  }
}

export class RustAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'RustAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: [
          'RUST_FUNCTION',
          'RUST_STRUCT',
          'RUST_IMPL',
          'RUST_METHOD',
          'RUST_TRAIT',
          'RUST_CALL'
        ],
        edges: ['CONTAINS', 'IMPLEMENTS']
      },
      dependencies: ['RustModuleIndexer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';
    const logger = this.log(context);

    // Load native binding lazily on first use
    await loadNativeBinding();

    if (!parseRustFile) {
      logger.info('Skipping - native binding not available');
      return createSuccessResult(
        { nodes: 0, edges: 0 },
        { skipped: true, reason: 'Native binding not available' }
      );
    }

    // Get all RUST_MODULE nodes
    const modules: NodeRecord[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'RUST_MODULE' })) {
      modules.push(node);
    }

    if (modules.length === 0) {
      logger.info('No RUST_MODULE nodes found, skipping');
      return createSuccessResult({ nodes: 0, edges: 0 }, { skipped: true, reason: 'No modules' });
    }

    logger.info('Analyzing Rust modules', { count: modules.length });

    const stats: AnalysisStats = {
      functions: 0,
      structs: 0,
      impls: 0,
      methods: 0,
      traits: 0,
      calls: 0,
      edges: 0
    };
    const errors: Array<{ file: string; error: string }> = [];

    for (let i = 0; i < modules.length; i++) {
      const module = modules[i];
      try {
        const code = readFileSync(resolveNodeFile(module.file!, projectPath), 'utf-8');
        const parseResult = parseRustFile(code);

        const result = await this.processParseResult(parseResult, module, graph, factory);
        stats.functions += result.functions;
        stats.structs += result.structs;
        stats.impls += result.impls;
        stats.methods += result.methods;
        stats.traits += result.traits;
        stats.calls += result.calls;
        stats.edges += result.edges;

        if (onProgress && (i + 1) % 5 === 0) {
          onProgress({
            phase: 'analysis',
            currentPlugin: 'RustAnalyzer',
            message: `Analyzed ${i + 1}/${modules.length} Rust modules`,
            totalFiles: modules.length,
            processedFiles: i + 1
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ file: module.file!, error: message });
        logger.warn('Error parsing module', {
          file: module.file,
          error: message
        });
      }
    }

    if (errors.length > 0) {
      logger.warn('Analysis completed with errors', { errorCount: errors.length });
    }

    logger.info('Analysis complete', { ...stats });
    return createSuccessResult(
      { nodes: stats.functions + stats.structs + stats.impls + stats.methods + stats.traits + stats.calls, edges: stats.edges },
      { ...stats, errors: errors.length }
    );
  }

  private async processParseResult(
    parseResult: RustParseResult,
    module: NodeRecord,
    graph: PluginContext['graph'],
    factory: PluginContext['factory'],
  ): Promise<AnalysisStats> {
    const nodes: AnyBrandedNode[] = [];
    const edges: EdgeToAdd[] = [];
    let methodCount = 0;
    let callCount = 0;

    // Helper to collect calls within a function/method
    const processCalls = (
      calls: RustCall[] | undefined,
      parentId: string,
      parentName: string
    ): void => {
      for (const call of calls || []) {
        const callNode = NodeFactory.createRustCall(
          parentName,
          module.file!,
          call.line,
          call.column,
          call.callType,
          call.argsCount,
          {
            name: call.name || null,
            receiver: call.receiver || null,
            method: call.method || null,
            sideEffect: call.sideEffect || null,
          }
        );

        nodes.push(callNode);
        edges.push({ src: parentId, dst: callNode.id, type: 'CONTAINS' });
        callCount++;
      }
    };

    // 1. Process top-level functions
    for (const fn of parseResult.functions) {
      const fnNode = NodeFactory.createRustFunction(
        fn.name,
        module.file!,
        fn.line,
        fn.column,
        {
          pub: fn.isPub,
          async: fn.isAsync,
          unsafe: fn.isUnsafe,
          const: fn.isConst,
          napi: fn.isNapi,
          napiJsName: fn.napiJsName || null,
          napiConstructor: fn.napiConstructor || false,
          napiGetter: fn.napiGetter || null,
          napiSetter: fn.napiSetter || null,
          params: fn.params || [],
          returnType: fn.returnType || null,
          unsafeBlocks: fn.unsafeBlocks?.length || 0,
        }
      );

      nodes.push(fnNode);
      edges.push({ src: module.id, dst: fnNode.id, type: 'CONTAINS' });

      // Process calls within this function
      processCalls(fn.calls, fnNode.id, fn.name);
    }

    // 2. Process structs
    for (const s of parseResult.structs) {
      const structNode = NodeFactory.createRustStruct(
        s.name,
        module.file!,
        s.line,
        {
          pub: s.isPub,
          napi: s.isNapi,
          fields: s.fields || [],
        }
      );

      nodes.push(structNode);
      edges.push({ src: module.id, dst: structNode.id, type: 'CONTAINS' });
    }

    // 3. Process impl blocks and their methods
    for (const impl of parseResult.impls) {
      const implNode = NodeFactory.createRustImpl(
        impl.targetType,
        module.file!,
        impl.line,
        { traitName: impl.traitName || null }
      );

      nodes.push(implNode);
      edges.push({ src: module.id, dst: implNode.id, type: 'CONTAINS' });

      // IMPLEMENTS edge if trait impl
      if (impl.traitName) {
        edges.push({
          src: implNode.id,
          dst: `RUST_TRAIT#${impl.traitName}`,
          type: 'IMPLEMENTS'
        });
      }

      // Process methods inside impl
      for (const method of impl.methods) {
        const methodNode = NodeFactory.createRustMethod(
          method.name,
          module.file!,
          method.line,
          method.column,
          implNode.id,
          impl.targetType,
          {
            pub: method.isPub,
            async: method.isAsync,
            unsafe: method.isUnsafe,
            const: method.isConst,
            napi: method.isNapi,
            napiJsName: method.napiJsName || null,
            napiConstructor: method.napiConstructor || false,
            napiGetter: method.napiGetter || null,
            napiSetter: method.napiSetter || null,
            params: method.params || [],
            returnType: method.returnType || null,
            selfType: method.selfType || null,
            unsafeBlocks: method.unsafeBlocks?.length || 0,
          }
        );

        nodes.push(methodNode);
        edges.push({ src: implNode.id, dst: methodNode.id, type: 'CONTAINS' });
        methodCount++;

        // Process calls within this method
        processCalls(method.calls, methodNode.id, `${impl.targetType}::${method.name}`);
      }
    }

    // 4. Process traits
    for (const t of parseResult.traits) {
      const traitNode = NodeFactory.createRustTrait(
        t.name,
        module.file!,
        t.line,
        {
          pub: t.isPub,
          methods: (t.methods || []).map(m => ({
            name: m.name,
            params: m.params,
            returnType: m.returnType,
          })),
        }
      );

      nodes.push(traitNode);
      edges.push({ src: module.id, dst: traitNode.id, type: 'CONTAINS' });
    }

    // 5. Write all nodes and edges in batch
    await factory!.storeMany(nodes);
    await factory!.linkMany(edges);

    return {
      functions: parseResult.functions.length,
      structs: parseResult.structs.length,
      impls: parseResult.impls.length,
      methods: methodCount,
      traits: parseResult.traits.length,
      calls: callCount,
      edges: edges.length
    };
  }
}
