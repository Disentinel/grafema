/**
 * ModuleRuntimeBuilder - buffers imports, exports, stdio, event listeners,
 * HTTP requests, rejection edges, and catches-from edges.
 *
 * Extracted from GraphBuilder: bufferImportNodes, bufferExportNodes,
 * bufferStdioNodes, bufferEventListeners, bufferHttpRequests,
 * bufferRejectionEdges, bufferCatchesFromEdges.
 */

import { ImportNode } from '../../../../core/nodes/ImportNode.js';
import { NetworkRequestNode } from '../../../../core/nodes/NetworkRequestNode.js';
import { NodeFactory } from '../../../../core/NodeFactory.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
import type {
  ModuleNode,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  MethodCallInfo,
  EventListenerInfo,
  HttpRequestInfo,
  RejectionPatternInfo,
  CatchesFromInfo,
  ASTCollections,
  GraphNode,
} from '../types.js';
import type { BuilderContext, DomainBuilder } from './types.js';

export class ModuleRuntimeBuilder implements DomainBuilder {
  constructor(private ctx: BuilderContext) {}

  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      functions,
      imports = [],
      exports: exportInfos = [],
      methodCalls = [],
      eventListeners = [],
      httpRequests = [],
      rejectionPatterns = [],
      catchesFromInfos = [],
    } = data;

    this.bufferImportNodes(module, imports);
    this.bufferExportNodes(module, exportInfos);
    this.bufferStdioNodes(methodCalls);
    this.bufferEventListeners(eventListeners, functions);
    this.bufferHttpRequests(httpRequests, functions);
    this.bufferRejectionEdges(functions, rejectionPatterns);
    this.bufferCatchesFromEdges(catchesFromInfos);
  }

  private bufferImportNodes(module: ModuleNode, imports: ImportInfo[]): void {
    for (const imp of imports) {
      const { source, specifiers, line, column, importKind, isDynamic, isResolvable, dynamicPath } = imp;

      // REG-273: Handle side-effect-only imports (no specifiers)
      if (specifiers.length === 0) {
        // Side-effect import: import './polyfill.js'
        const importNode = ImportNode.create(
          source,               // name = source (no local binding)
          module.file,          // file
          line,                 // line (stored as field, not in ID)
          column || 0,          // column
          source,               // source module
          {
            imported: '*',      // no specific export
            local: source,      // source becomes local
            sideEffect: true,   // mark as side-effect import
            importBinding: importKind || 'value'
          }
        );

        this.ctx.bufferNode(importNode as unknown as GraphNode);

        // MODULE -> CONTAINS -> IMPORT
        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: importNode.id
        });

        // Create EXTERNAL_MODULE node for external modules
        const isRelative = source.startsWith('./') || source.startsWith('../');
        if (!isRelative) {
          const externalModule = NodeFactory.createExternalModule(source);

          // Avoid duplicate EXTERNAL_MODULE nodes
          if (!this.ctx.isCreated(externalModule.id)) {
            this.ctx.bufferNode(externalModule as unknown as GraphNode);
            this.ctx.markCreated(externalModule.id);
          }

          this.ctx.bufferEdge({
            type: 'IMPORTS',
            src: module.id,
            dst: externalModule.id
          });
        }
      } else {
        // Regular imports with specifiers
        for (const spec of specifiers) {
          // Use ImportNode factory for proper semantic IDs and field population
          const importNode = ImportNode.create(
            spec.local,           // name = local binding
            module.file,          // file
            line,                 // line (stored as field, not in ID)
            column || 0,          // column
            source,               // source module
            {
              imported: spec.imported,
              local: spec.local,
              sideEffect: false,  // regular imports are not side-effects
              importBinding: spec.importKind === 'type' ? 'type' : (importKind || 'value'),
              // importType is auto-detected from imported field
              // Dynamic import fields
              isDynamic,
              isResolvable,
              dynamicPath
            }
          );

          this.ctx.bufferNode(importNode as unknown as GraphNode);

          // MODULE -> CONTAINS -> IMPORT
          this.ctx.bufferEdge({
            type: 'CONTAINS',
            src: module.id,
            dst: importNode.id
          });

          // Create EXTERNAL_MODULE node for external modules
          const isRelative = source.startsWith('./') || source.startsWith('../');
          if (!isRelative) {
            const externalModule = NodeFactory.createExternalModule(source);

            // Avoid duplicate EXTERNAL_MODULE nodes
            if (!this.ctx.isCreated(externalModule.id)) {
              this.ctx.bufferNode(externalModule as unknown as GraphNode);
              this.ctx.markCreated(externalModule.id);
            }

            this.ctx.bufferEdge({
              type: 'IMPORTS',
              src: module.id,
              dst: externalModule.id
            });
          }
        }
      }
    }
  }

  private bufferExportNodes(module: ModuleNode, exports: ExportInfo[]): void {
    for (const exp of exports) {
      const { type, line, name, specifiers, source } = exp;

      if (type === 'default') {
        const exportNode = NodeFactory.createExport(
          'default',
          module.file,
          line,
          0,
          { default: true, exportType: 'default' }
        );

        this.ctx.bufferNode(exportNode as unknown as GraphNode);

        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: exportNode.id
        });
      } else if (type === 'named') {
        if (specifiers) {
          for (const spec of specifiers) {
            const exportNode = NodeFactory.createExport(
              spec.exported,
              module.file,
              line,
              0,
              {
                local: spec.local,
                source: source,
                exportType: 'named'
              }
            );

            this.ctx.bufferNode(exportNode as unknown as GraphNode);

            this.ctx.bufferEdge({
              type: 'CONTAINS',
              src: module.id,
              dst: exportNode.id
            });
          }
        } else if (name) {
          const exportNode = NodeFactory.createExport(
            name,
            module.file,
            line,
            0,
            { exportType: 'named' }
          );

          this.ctx.bufferNode(exportNode as unknown as GraphNode);

          this.ctx.bufferEdge({
            type: 'CONTAINS',
            src: module.id,
            dst: exportNode.id
          });
        }
      } else if (type === 'all') {
        const exportNode = NodeFactory.createExport(
          '*',
          module.file,
          line,
          0,
          {
            source: source,
            exportType: 'all'
          }
        );

        this.ctx.bufferNode(exportNode as unknown as GraphNode);

        this.ctx.bufferEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: exportNode.id
        });
      }
    }
  }

  private bufferStdioNodes(methodCalls: MethodCallInfo[]): void {
    const consoleIOMethods = methodCalls.filter(mc =>
      (mc.object === 'console' && (mc.method === 'log' || mc.method === 'error'))
    );

    if (consoleIOMethods.length > 0) {
      const stdioNode = NodeFactory.createExternalStdio();

      // Buffer net:stdio node only once (singleton)
      if (!this.ctx.isCreated(stdioNode.id)) {
        this.ctx.bufferNode(stdioNode as unknown as GraphNode);
        this.ctx.markCreated(stdioNode.id);
      }

      // Buffer WRITES_TO edges for console.log/error
      for (const methodCall of consoleIOMethods) {
        this.ctx.bufferEdge({
          type: 'WRITES_TO',
          src: methodCall.id,
          dst: stdioNode.id
        });
      }
    }
  }

  private bufferEventListeners(eventListeners: EventListenerInfo[], functions: FunctionInfo[]): void {
    for (const eventListener of eventListeners) {
      const { parentScopeId, callbackArg, ...listenerData } = eventListener;

      this.ctx.bufferNode(listenerData as GraphNode);

      this.ctx.bufferEdge({
        type: 'CONTAINS',
        src: parentScopeId as string,
        dst: listenerData.id
      });

      if (callbackArg && callbackArg.type === 'ArrowFunctionExpression') {
        const callbackLine = (callbackArg.loc as { start: { line: number } }).start.line;
        const callbackFunction = functions.find(f =>
          f.line === callbackLine && f.arrowFunction
        );

        if (callbackFunction) {
          this.ctx.bufferEdge({
            type: 'HANDLED_BY',
            src: listenerData.id,
            dst: callbackFunction.id
          });
        }
      }
    }
  }

  private bufferHttpRequests(httpRequests: HttpRequestInfo[], functions: FunctionInfo[]): void {
    if (httpRequests.length > 0) {
      // Create net:request singleton using factory
      const networkNode = NetworkRequestNode.create();

      if (!this.ctx.isCreated(networkNode.id)) {
        this.ctx.bufferNode(networkNode as unknown as GraphNode);
        this.ctx.markCreated(networkNode.id);
      }

      for (const request of httpRequests) {
        const { parentScopeId, ...requestData } = request;

        this.ctx.bufferNode(requestData as GraphNode);

        this.ctx.bufferEdge({
          type: 'CALLS',
          src: request.id,
          dst: networkNode.id
        });

        if (parentScopeId) {
          const scopeParts = parentScopeId.split(':');
          if (scopeParts.length >= 3 && scopeParts[1] === 'SCOPE') {
            const functionName = scopeParts[2];
            const file = scopeParts[0];

            const parentFunction = functions.find(f =>
              f.file === file && f.name === functionName
            );

            if (parentFunction) {
              this.ctx.bufferEdge({
                type: 'MAKES_REQUEST',
                src: parentFunction.id,
                dst: request.id
              });
            }
          }
        }
      }
    }
  }

  /**
   * Buffer REJECTS edges for async error tracking (REG-311).
   *
   * Creates edges from FUNCTION nodes to error CLASS nodes they can reject.
   * This enables tracking which async functions can throw which error types:
   *
   * - Promise.reject(new Error()) -> FUNCTION --REJECTS--> CLASS[Error]
   * - reject(new ValidationError()) in executor -> FUNCTION --REJECTS--> CLASS[ValidationError]
   * - throw new AuthError() in async function -> FUNCTION --REJECTS--> CLASS[AuthError]
   *
   * Also stores rejectionPatterns in function metadata for downstream enrichers.
   *
   * @param functions - All function infos from analysis
   * @param rejectionPatterns - Collected rejection patterns from analysis
   */
  private bufferRejectionEdges(functions: FunctionInfo[], rejectionPatterns: RejectionPatternInfo[]): void {
    // Group rejection patterns by functionId for efficient lookup
    const patternsByFunction = new Map<string, RejectionPatternInfo[]>();
    for (const pattern of rejectionPatterns) {
      const existing = patternsByFunction.get(pattern.functionId);
      if (existing) {
        existing.push(pattern);
      } else {
        patternsByFunction.set(pattern.functionId, [pattern]);
      }
    }

    // Process each function that has rejection patterns
    for (const [functionId, patterns] of patternsByFunction) {
      // REG-286: Split patterns by sync/async to create correct edge types
      // Sync throws -> THROWS edges, async patterns -> REJECTS edges
      const syncErrorClasses = new Set<string>();
      const asyncErrorClasses = new Set<string>();
      for (const pattern of patterns) {
        if (pattern.errorClassName) {
          if (pattern.isAsync) {
            asyncErrorClasses.add(pattern.errorClassName);
          } else {
            syncErrorClasses.add(pattern.errorClassName);
          }
        }
      }

      // Find the function's file to compute class IDs
      const func = functions.find(f => f.id === functionId);
      const file = func?.file ?? '';
      const globalContext = { file, scopePath: [] as string[] };

      // Create REJECTS edges for async error patterns (REG-311)
      for (const errorClassName of asyncErrorClasses) {
        const classId = computeSemanticId('CLASS', errorClassName, globalContext);
        this.ctx.bufferEdge({
          type: 'REJECTS',
          src: functionId,
          dst: classId,
          metadata: { errorClassName }
        });
      }

      // Create THROWS edges for sync throw patterns (REG-286)
      for (const errorClassName of syncErrorClasses) {
        const classId = computeSemanticId('CLASS', errorClassName, globalContext);
        this.ctx.bufferEdge({
          type: 'THROWS',
          src: functionId,
          dst: classId,
          metadata: { errorClassName }
        });
      }

      // Store rejection patterns in function metadata for downstream enrichers
      // Find and update the function node in the buffer
      const node = this.ctx.findBufferedNode(functionId);
      if (node) {
        // Store in metadata field for proper persistence and test compatibility
        if (!node.metadata) {
          node.metadata = {};
        }
        (node.metadata as Record<string, unknown>).rejectionPatterns = patterns.map(p => ({
          rejectionType: p.rejectionType,
          errorClassName: p.errorClassName,
          line: p.line,
          column: p.column,
          sourceVariableName: p.sourceVariableName,
          tracePath: p.tracePath
        }));
      }
    }
  }

  /**
   * Buffer CATCHES_FROM edges linking catch blocks to error sources (REG-311).
   *
   * Creates edges from CATCH_BLOCK nodes to potential error sources within
   * their corresponding try blocks. This enables tracking which catch blocks
   * can handle which exceptions:
   *
   * - try { await fetch() } catch(e) -> CATCH_BLOCK --CATCHES_FROM--> CALL[fetch]
   * - try { throw new Error() } catch(e) -> CATCH_BLOCK --CATCHES_FROM--> THROW_STATEMENT
   *
   * The sourceType metadata helps distinguish different error source kinds
   * for more precise error flow analysis.
   *
   * @param catchesFromInfos - Collected CATCHES_FROM info from analysis
   */
  private bufferCatchesFromEdges(catchesFromInfos: CatchesFromInfo[]): void {
    for (const info of catchesFromInfos) {
      this.ctx.bufferEdge({
        type: 'CATCHES_FROM',
        src: info.catchBlockId,
        dst: info.sourceId,
        metadata: {
          parameterName: info.parameterName,
          sourceType: info.sourceType,
          sourceLine: info.sourceLine
        }
      });
    }
  }
}
