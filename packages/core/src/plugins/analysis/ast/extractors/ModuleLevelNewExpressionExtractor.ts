import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getLine, getColumn } from '../utils/location.js';
import { ConstructorCallNode } from '../../../../core/nodes/ConstructorCallNode.js';
import { ArgumentExtractor } from '../visitors/ArgumentExtractor.js';
import type { ArgumentInfo, LiteralInfo as ExtractorLiteralInfo } from '../visitors/call-expression-types.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import type { VisitorModule } from '../visitors/index.js';
import type {
  ConstructorCallInfo,
  CallArgumentInfo,
  LiteralInfo,
  PromiseExecutorContext,
  CounterRef,
} from '../types.js';

interface ModuleLevelNewExpressionContext {
  module: VisitorModule;
  scopeTracker: ScopeTracker;
  constructorCalls: ConstructorCallInfo[];
  callArguments: CallArgumentInfo[];
  literals: LiteralInfo[];
  literalCounterRef: CounterRef;
  allCollections: Record<string, unknown>;
  promiseExecutorContexts: Map<string, PromiseExecutorContext>;
}

export function createModuleLevelNewExpressionVisitor(
  ctx: ModuleLevelNewExpressionContext
): { NewExpression: (newPath: NodePath<t.NewExpression>) => void } {
  const processedConstructorCalls = new Set<string>();

  return {
    NewExpression: (newPath: NodePath<t.NewExpression>) => {
      const newNode = newPath.node;
      const nodeKey = `constructor:new:${newNode.start}:${newNode.end}`;
      if (processedConstructorCalls.has(nodeKey)) {
        return;
      }

      // Skip in-function calls — handled by NewExpressionHandler in analyzeFunctionBody
      const functionParent = newPath.getFunctionParent();
      if (functionParent) return;

      processedConstructorCalls.add(nodeKey);

      // Determine className from callee
      let className: string | null = null;
      if (newNode.callee.type === 'Identifier') {
        className = newNode.callee.name;
      } else if (newNode.callee.type === 'MemberExpression' && newNode.callee.property.type === 'Identifier') {
        className = newNode.callee.property.name;
      }

      if (className) {
        const line = getLine(newNode);
        const column = getColumn(newNode);
        const constructorCallId = ConstructorCallNode.generateId(className, ctx.module.file, line, column);
        const isBuiltin = ConstructorCallNode.isBuiltinConstructor(className);

        ctx.constructorCalls.push({
          id: constructorCallId,
          type: 'CONSTRUCTOR_CALL',
          className,
          isBuiltin,
          file: ctx.module.file,
          line,
          column,
          parentScopeId: ctx.module.id
        });

        // REG-532: Extract constructor arguments for PASSES_ARGUMENT + DERIVES_FROM edges
        if (newNode.arguments.length > 0) {
          ArgumentExtractor.extract(
            newNode.arguments, constructorCallId, ctx.module,
            ctx.callArguments as unknown as ArgumentInfo[],
            ctx.literals as unknown as ExtractorLiteralInfo[], ctx.literalCounterRef,
            ctx.allCollections, ctx.scopeTracker
          );
        }

        // REG-334: If this is Promise constructor with executor callback,
        // register the context for resolve/reject detection
        if (className === 'Promise' && newNode.arguments.length > 0) {
          const executorArg = newNode.arguments[0];

          // Only handle inline function expressions (not variable references)
          if (t.isArrowFunctionExpression(executorArg) || t.isFunctionExpression(executorArg)) {
            // Extract resolve/reject parameter names
            let resolveName: string | undefined;
            let rejectName: string | undefined;

            if (executorArg.params.length > 0 && t.isIdentifier(executorArg.params[0])) {
              resolveName = executorArg.params[0].name;
            }
            if (executorArg.params.length > 1 && t.isIdentifier(executorArg.params[1])) {
              rejectName = executorArg.params[1].name;
            }

            if (resolveName) {
              // Key by function node position to allow nested Promise detection
              const funcKey = `${executorArg.start}:${executorArg.end}`;
              ctx.promiseExecutorContexts.set(funcKey, {
                constructorCallId,
                resolveName,
                rejectName,
                file: ctx.module.file,
                line,
                // REG-311: Module-level Promise has no creator function
                creatorFunctionId: undefined
              });
            }
          }
        }
      }
    }
  };
}
