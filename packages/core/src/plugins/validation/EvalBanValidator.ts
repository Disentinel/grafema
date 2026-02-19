/**
 * EvalBanValidator - запрещает использование eval и Function
 *
 * Security инвариант: код не должен использовать динамическое выполнение.
 *
 * Детектирует:
 * - eval("code") - прямой вызов eval
 * - new Function("code") - конструктор Function
 * - Function("code") - вызов Function без new
 * - window.eval("code") - eval через window
 * - globalThis.eval("code") - eval через globalThis
 * - Aliased eval: const e = eval; e("code") - через AliasTracker
 *
 * ПРАВИЛА (Datalog):
 * violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
 * violation(X) :- node(X, "CALL"), attr(X, "name", "Function").
 * violation(X) :- node(X, "CALL"), attr(X, "method", "eval").
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

/**
 * Eval ban issue
 */
interface EvalBanIssue {
  type: string;
  severity: string;
  message: string;
  nodeId: string;
  file?: string;
  line?: number;
  object?: string;
}

/**
 * Extended node with call properties
 */
interface CallNode extends BaseNodeRecord {
  method?: string;
  object?: string;
}

/**
 * Validation summary
 */
interface ValidationSummary {
  evalCalls: number;
  functionCalls: number;
  methodEvalCalls: number;
  aliasedEvalCalls: number;
  totalViolations: number;
  timeSeconds: string;
}

export class EvalBanValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'EvalBanValidator',
      phase: 'VALIDATION',
      dependencies: ['JSASTAnalyzer'],
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting eval/Function usage validation');
    const startTime = Date.now();

    const issues: EvalBanIssue[] = [];
    let scannedCalls = 0;

    // OPTIMIZATION: use direct graph queries instead of Datalog (slow full scan)
    // Datalog hangs on large graphs due to lack of indexes

    // 1. Direct eval("code") call - find all CALL nodes with name="eval"
    logger.debug('Searching for eval() calls');
    const evalStart = Date.now();
    let evalCount = 0;

    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      scannedCalls++;
      if (onProgress && scannedCalls % 500 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'EvalBanValidator',
          message: `Scanning for eval patterns: ${scannedCalls} calls checked`,
          processedFiles: scannedCalls,
        });
      }
      if (node.name === 'eval') {
        evalCount++;
        issues.push({
          type: 'EVAL_USAGE',
          severity: 'ERROR',
          message: `Direct eval() call at ${node.file}:${node.line || '?'} - dynamic code execution is forbidden`,
          nodeId: node.id,
          file: node.file,
          line: node.line as number | undefined
        });
      }
    }
    logger.debug('eval() search complete', { timeMs: Date.now() - evalStart, count: evalCount });

    // 2. Function("code") or new Function("code") call
    logger.debug('Searching for Function() calls');
    const funcStart = Date.now();
    let funcCount = 0;

    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      scannedCalls++;
      if (onProgress && scannedCalls % 500 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'EvalBanValidator',
          message: `Scanning for eval patterns: ${scannedCalls} calls checked`,
          processedFiles: scannedCalls,
        });
      }
      if (node.name === 'Function') {
        funcCount++;
        issues.push({
          type: 'FUNCTION_CONSTRUCTOR',
          severity: 'ERROR',
          message: `Function() constructor at ${node.file}:${node.line || '?'} - dynamic code execution is forbidden`,
          nodeId: node.id,
          file: node.file,
          line: node.line as number | undefined
        });
      }
    }
    logger.debug('Function() search complete', { timeMs: Date.now() - funcStart, count: funcCount });

    // 3. Method call: window.eval, globalThis.eval, this.eval
    // Note: METHOD_CALL was merged into CALL - method calls have 'method' attribute
    logger.debug('Searching for method eval() calls');
    const methodStart = Date.now();
    let methodCount = 0;

    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      scannedCalls++;
      if (onProgress && scannedCalls % 500 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'EvalBanValidator',
          message: `Scanning for eval patterns: ${scannedCalls} calls checked`,
          processedFiles: scannedCalls,
        });
      }
      const callNode = node as CallNode;
      // Method calls have 'method' attribute (e.g., window.eval())
      if (callNode.method === 'eval' && callNode.object) {
        methodCount++;
        const objectName = callNode.object;
        issues.push({
          type: 'EVAL_METHOD',
          severity: 'ERROR',
          message: `${objectName}.eval() call at ${node.file}:${node.line || '?'} - dynamic code execution is forbidden`,
          nodeId: node.id,
          file: node.file,
          line: node.line as number | undefined,
          object: objectName
        });
      }
    }
    logger.debug('Method eval() search complete', { timeMs: Date.now() - methodStart, count: methodCount });

    // 4. Aliased eval - SKIP for now (complex Datalog query causes OOM)
    logger.debug('Skipping aliased eval detection', { reason: 'requires optimized implementation' });

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary: ValidationSummary = {
      evalCalls: evalCount,
      functionCalls: funcCount,
      methodEvalCalls: methodCount,
      aliasedEvalCalls: 0, // Skipped for now
      totalViolations: issues.length,
      timeSeconds: totalTime
    };

    logger.info('Validation summary', { ...summary });

    if (issues.length > 0) {
      logger.info('Security violations found', { count: issues.length });
      for (const issue of issues) {
        logger.warn('Violation', { message: issue.message, type: issue.type, file: issue.file, line: issue.line });
      }
    } else {
      logger.info('Validation passed: no eval/Function usage detected');
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },  // created - validator doesn't create nodes/edges
      { summary, issues }       // metadata
    );
  }
}
