/**
 * AwaitInLoopValidator — detects sequential await in loops (REG-298)
 *
 * Performance issue: sequential `await` in a loop processes items one at a time
 * when they could often be parallelized with `Promise.all()`.
 *
 * Detection: CALL nodes with `isAwaited=true AND isInsideLoop=true`
 * (forward-registered during AST walk via `controlFlowState.loopDepth`).
 *
 * Creates `issue:performance` ISSUE nodes with AFFECTS edges to flagged calls.
 *
 * Datalog equivalent:
 *   await_in_loop(Call) :-
 *     node(Call, "CALL"),
 *     attr(Call, "isAwaited", true),
 *     attr(Call, "isInsideLoop", true).
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';

interface CallNode {
  id: string;
  name?: string;
  file?: string;
  line?: number;
  column?: number;
  isAwaited?: boolean;
  isInsideLoop?: boolean;
}

export class AwaitInLoopValidator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'AwaitInLoopValidator',
      phase: 'VALIDATION',
      dependencies: ['JSASTAnalyzer'],
      creates: {
        nodes: ['ISSUE'],
        edges: ['AFFECTS']
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting await-in-loop detection');

    let issueCount = 0;

    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const call = node as unknown as CallNode;

      if (call.isAwaited && call.isInsideLoop) {
        const callName = call.name || 'unknown';
        const location = `${call.file}:${call.line || '?'}`;

        if (context.reportIssue) {
          await context.reportIssue({
            category: 'performance',
            severity: 'warning',
            message: `Sequential await in loop at ${location} — consider Promise.all() for parallel execution`,
            file: call.file || '',
            line: call.line || 0,
            column: call.column || 0,
            targetNodeId: call.id,
            context: {
              type: 'AWAIT_IN_LOOP',
              callName,
              suggestion: 'Promise.all'
            }
          });
          issueCount++;
        }
      }
    }

    if (issueCount > 0) {
      logger.info('Sequential await-in-loop issues found', { count: issueCount });
    } else {
      logger.info('No await-in-loop issues found');
    }

    return createSuccessResult(
      { nodes: issueCount, edges: issueCount },
      { issueCount }
    );
  }
}
