import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { getLine, getColumn } from './location.js';
import type {
  CatchBlockInfo,
  CallSiteInfo,
  MethodCallInfo,
  ConstructorCallInfo,
  CatchesFromInfo,
} from '../types.js';
import type { VisitorModule } from '../visitors/index.js';

export function collectCatchesFromInfo(
  funcPath: NodePath<t.Function>,
  catchBlocks: CatchBlockInfo[],
  callSites: CallSiteInfo[],
  methodCalls: MethodCallInfo[],
  constructorCalls: ConstructorCallInfo[],
  catchesFromInfos: CatchesFromInfo[],
  module: VisitorModule
): void {
  // Traverse to find TryStatements and collect sources
  funcPath.traverse({
    TryStatement: (tryPath: NodePath<t.TryStatement>) => {
      const tryNode = tryPath.node;
      const handler = tryNode.handler;

      // Skip if no catch clause
      if (!handler) return;

      // Find the catch block for this try
      // Match by line number since we don't have the tryBlockId here
      const catchLine = getLine(handler);
      const catchBlock = catchBlocks.find(cb =>
        cb.file === module.file && cb.line === catchLine
      );

      if (!catchBlock || !catchBlock.parameterName) return;

      // Traverse only the try block body (not catch or finally)
      const _tryBody = tryNode.block;
      const sources: Array<{ id: string; type: CatchesFromInfo['sourceType']; line: number }> = [];

      // Collect sources from try block
      tryPath.get('block').traverse({
        // Stop at nested TryStatement - don't collect from inner try blocks
        TryStatement: (innerPath) => {
          innerPath.skip(); // Don't traverse into nested try blocks
        },

        // Stop at function boundaries - don't collect from nested functions
        Function: (innerFuncPath) => {
          innerFuncPath.skip();
        },

        CallExpression: (callPath: NodePath<t.CallExpression>) => {
          const callNode = callPath.node;
          const callLine = getLine(callNode);
          const callColumn = getColumn(callNode);

          // Check if this is an awaited call
          const parent = callPath.parentPath;
          const isAwaited = parent?.isAwaitExpression() ?? false;

          // Find the CALL node that matches this CallExpression
          let sourceId: string | null = null;
          let sourceType: CatchesFromInfo['sourceType'] = 'sync_call';

          // Check method calls first (includes Promise.reject which is a method call)
          const matchingMethodCall = methodCalls.find(mc =>
            mc.file === module.file &&
            mc.line === callLine &&
            mc.column === callColumn
          );

          if (matchingMethodCall) {
            sourceId = matchingMethodCall.id;
            sourceType = isAwaited ? 'awaited_call' : 'sync_call';
          } else {
            // Check direct function calls
            const matchingCallSite = callSites.find(cs =>
              cs.file === module.file &&
              cs.line === callLine &&
              cs.column === callColumn
            );

            if (matchingCallSite) {
              sourceId = matchingCallSite.id;
              sourceType = isAwaited ? 'awaited_call' : 'sync_call';
            }
          }

          if (sourceId) {
            sources.push({ id: sourceId, type: sourceType, line: callLine });
          }
        },

        ThrowStatement: (throwPath: NodePath<t.ThrowStatement>) => {
          const throwNode = throwPath.node;
          const throwLine = getLine(throwNode);
          const throwColumn = getColumn(throwNode);

          // Create a synthetic ID for the throw statement
          // We don't have THROW_STATEMENT nodes, so we use line/column as identifier
          const sourceId = `THROW#${module.file}#${throwLine}:${throwColumn}`;

          sources.push({ id: sourceId, type: 'throw_statement', line: throwLine });
        },

        NewExpression: (newPath: NodePath<t.NewExpression>) => {
          // Skip NewExpression that is direct argument of ThrowStatement
          // In `throw new Error()`, the throw statement is the primary source
          if (newPath.parentPath?.isThrowStatement()) {
            return;
          }

          const newNode = newPath.node;
          const newLine = getLine(newNode);
          const newColumn = getColumn(newNode);

          // Find matching constructor call
          const matchingConstructor = constructorCalls.find(cc =>
            cc.file === module.file &&
            cc.line === newLine &&
            cc.column === newColumn
          );

          if (matchingConstructor) {
            sources.push({ id: matchingConstructor.id, type: 'constructor_call', line: newLine });
          }
        }
      });

      // Create CatchesFromInfo for each source
      for (const source of sources) {
        catchesFromInfos.push({
          catchBlockId: catchBlock.id,
          parameterName: catchBlock.parameterName,
          sourceId: source.id,
          sourceType: source.type,
          file: module.file,
          sourceLine: source.line
        });
      }
    }
  });
}
