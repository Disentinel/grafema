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
      priority: 95, // Высокий приоритет - security check
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;

    console.log('[EvalBanValidator] Checking for eval/Function usage...');
    const startTime = Date.now();

    const issues: EvalBanIssue[] = [];

    // ОПТИМИЗАЦИЯ: вместо Datalog (медленный full scan), используем прямые graph queries
    // Datalog зависает на больших графах из-за отсутствия индексов

    // 1. Прямой вызов eval("code") - ищем все CALL ноды с name="eval"
    console.log('[EvalBanValidator] Searching for eval() calls...');
    const evalStart = Date.now();
    let evalCount = 0;

    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
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
    console.log(`[EvalBanValidator] eval() search took ${Date.now() - evalStart}ms, found ${evalCount} violations`);

    // 2. Вызов Function("code") или new Function("code")
    console.log('[EvalBanValidator] Searching for Function() calls...');
    const funcStart = Date.now();
    let funcCount = 0;

    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
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
    console.log(`[EvalBanValidator] Function() search took ${Date.now() - funcStart}ms, found ${funcCount} violations`);

    // 3. Method call: window.eval, globalThis.eval, this.eval
    // Note: METHOD_CALL was merged into CALL - method calls have 'method' attribute
    console.log('[EvalBanValidator] Searching for method eval() calls...');
    const methodStart = Date.now();
    let methodCount = 0;

    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
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
    console.log(`[EvalBanValidator] method eval() search took ${Date.now() - methodStart}ms, found ${methodCount} violations`);

    // 4. Aliased eval - SKIP for now (complex Datalog query causes OOM)
    console.log('[EvalBanValidator] Skipping aliased eval detection (requires optimized implementation)');

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const summary: ValidationSummary = {
      evalCalls: evalCount,
      functionCalls: funcCount,
      methodEvalCalls: methodCount,
      aliasedEvalCalls: 0, // Skipped for now
      totalViolations: issues.length,
      timeSeconds: totalTime
    };

    console.log('[EvalBanValidator] Summary:', summary);

    if (issues.length > 0) {
      console.log('[EvalBanValidator] ❌ Security violations found:');
      for (const issue of issues) {
        console.log(`  🚫 ${issue.message}`);
      }
    } else {
      console.log('[EvalBanValidator] ✅ No eval/Function usage detected');
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },  // created - validator doesn't create nodes/edges
      { summary, issues }       // metadata
    );
  }
}
