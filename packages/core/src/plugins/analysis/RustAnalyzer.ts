/**
 * RustAnalyzer - plugin for analyzing Rust source files
 * Uses syn parser via NAPI to extract functions, structs, impl blocks, traits
 * Detects #[napi] attributes for FFI linking
 */

import { readFileSync } from 'fs';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';

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

// NAPI binding - will be exported from rust-engine after build
let parseRustFile: ((code: string) => RustParseResult) | undefined;

// Try to load the native binding
// Path: from dist/plugins/analysis/ go up 5 levels to reach project root, then rust-engine/
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nativeBinding = await import('../../../../../rust-engine/grafema-graph-engine.node' as any);
  parseRustFile = nativeBinding.parseRustFile;
} catch {
  // Fallback: try require
  try {
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const nativeBinding = require('../../../../../rust-engine/grafema-graph-engine.node');
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
      priority: 75, // Lower than JSASTAnalyzer (80)
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
    const logger = this.log(context);

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
        const code = readFileSync(module.file!, 'utf-8');
        const parseResult = parseRustFile(code);

        const result = await this.processParseResult(parseResult, module, graph);
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
        errors.push({ file: module.file!, error: (err as Error).message });
        logger.warn('Error parsing module', {
          file: module.file,
          error: (err as Error).message
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
    graph: PluginContext['graph']
  ): Promise<AnalysisStats> {
    const edges: EdgeToAdd[] = [];
    let methodCount = 0;
    let callCount = 0;

    // Helper to process calls within a function/method
    const processCalls = async (
      calls: RustCall[] | undefined,
      parentId: string,
      parentName: string
    ): Promise<void> => {
      for (const call of calls || []) {
        const callId = `RUST_CALL#${parentName}#${call.line}#${call.column}#${module.file}`;

        await graph.addNode({
          id: callId,
          type: 'RUST_CALL',
          file: module.file,
          line: call.line,
          column: call.column,
          callType: call.callType, // "function" | "method" | "macro"
          name: call.name || null,
          receiver: call.receiver || null,
          method: call.method || null,
          argsCount: call.argsCount,
          sideEffect: call.sideEffect || null // "fs:write", "panic", "io:print", etc.
        } as unknown as NodeRecord);

        edges.push({ src: parentId, dst: callId, type: 'CONTAINS' });
        callCount++;
      }
    };

    // 1. Process top-level functions
    for (const fn of parseResult.functions) {
      const nodeId = `RUST_FUNCTION#${fn.name}#${module.file}#${fn.line}`;

      await graph.addNode({
        id: nodeId,
        type: 'RUST_FUNCTION',
        name: fn.name,
        file: module.file,
        line: fn.line,
        column: fn.column,
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
        unsafeBlocks: fn.unsafeBlocks?.length || 0 // Count of unsafe blocks in body
      } as unknown as NodeRecord);

      edges.push({ src: module.id, dst: nodeId, type: 'CONTAINS' });

      // Process calls within this function
      await processCalls(fn.calls, nodeId, fn.name);
    }

    // 2. Process structs
    for (const s of parseResult.structs) {
      const nodeId = `RUST_STRUCT#${s.name}#${module.file}#${s.line}`;

      await graph.addNode({
        id: nodeId,
        type: 'RUST_STRUCT',
        name: s.name,
        file: module.file,
        line: s.line,
        pub: s.isPub,
        napi: s.isNapi,
        fields: s.fields || []
      } as unknown as NodeRecord);

      edges.push({ src: module.id, dst: nodeId, type: 'CONTAINS' });
    }

    // 3. Process impl blocks and their methods
    for (const impl of parseResult.impls) {
      const implId = `RUST_IMPL#${impl.targetType}${impl.traitName ? ':' + impl.traitName : ''}#${module.file}#${impl.line}`;

      await graph.addNode({
        id: implId,
        type: 'RUST_IMPL',
        name: impl.targetType,
        traitName: impl.traitName || null,
        file: module.file,
        line: impl.line
      } as unknown as NodeRecord);

      edges.push({ src: module.id, dst: implId, type: 'CONTAINS' });

      // IMPLEMENTS edge if trait impl
      if (impl.traitName) {
        edges.push({
          src: implId,
          dst: `RUST_TRAIT#${impl.traitName}`,
          type: 'IMPLEMENTS'
        });
      }

      // Process methods inside impl
      for (const method of impl.methods) {
        const methodId = `RUST_METHOD#${method.name}#${module.file}#${method.line}`;

        await graph.addNode({
          id: methodId,
          type: 'RUST_METHOD',
          name: method.name,
          file: module.file,
          line: method.line,
          column: method.column,
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
          implId: implId,
          implType: impl.targetType,
          unsafeBlocks: method.unsafeBlocks?.length || 0 // Count of unsafe blocks in body
        } as unknown as NodeRecord);

        edges.push({ src: implId, dst: methodId, type: 'CONTAINS' });
        methodCount++;

        // Process calls within this method
        await processCalls(method.calls, methodId, `${impl.targetType}::${method.name}`);
      }
    }

    // 4. Process traits
    for (const t of parseResult.traits) {
      const nodeId = `RUST_TRAIT#${t.name}#${module.file}#${t.line}`;

      await graph.addNode({
        id: nodeId,
        type: 'RUST_TRAIT',
        name: t.name,
        file: module.file,
        line: t.line,
        pub: t.isPub,
        methods: (t.methods || []).map(m => ({
          name: m.name,
          params: m.params,
          returnType: m.returnType
        }))
      } as unknown as NodeRecord);

      edges.push({ src: module.id, dst: nodeId, type: 'CONTAINS' });
    }

    // 5. Write all edges
    for (const edge of edges) {
      await graph.addEdge(edge);
    }

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
