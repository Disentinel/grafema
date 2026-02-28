/**
 * extractModuleCollections — shared extraction function for AST analysis.
 *
 * Reads a JS/TS file, parses it with Babel, runs all visitors/traversals,
 * and returns ASTCollections ready for GraphBuilder.
 *
 * Used by both:
 * - Sequential path: JSASTAnalyzer.analyzeModule()
 * - Parallel path: ASTWorker (via worker_threads)
 *
 * REG-579: Extracted to unify parallel/sequential AST analysis paths.
 */
import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { TraverseOptions, NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

import { getTraverseFunction } from './utils/babelTraverse.js';
import { ScopeTracker } from '../../../core/ScopeTracker.js';
import { IdGenerator } from './IdGenerator.js';
import { CollisionResolver } from './CollisionResolver.js';
import { createCollections } from './utils/createCollections.js';
import { toASTCollections } from './utils/toASTCollections.js';
import { extractNamesFromPattern } from './utils/extractNamesFromPattern.js';
import {
  ImportExportVisitor,
  VariableVisitor,
  FunctionVisitor,
  ClassVisitor,
  CallExpressionVisitor,
  TypeScriptVisitor,
  PropertyAccessVisitor,
  type TrackVariableAssignmentCallback,
} from './visitors/index.js';
import {
  collectUpdateExpression as collectUpdateExpressionFn,
} from './mutation-detection/index.js';
import {
  trackVariableAssignment as trackVariableAssignmentFn,
} from './extractors/index.js';
import { createModuleLevelAssignmentVisitor } from './extractors/ModuleLevelAssignmentExtractor.js';
import { createModuleLevelNewExpressionVisitor } from './extractors/ModuleLevelNewExpressionExtractor.js';
import { createModuleLevelCallbackVisitor } from './extractors/ModuleLevelCallbackExtractor.js';
import { createModuleLevelIfStatementVisitor } from './extractors/ModuleLevelIfStatementExtractor.js';
import { createMiscEdgeHandlers } from './visitors/MiscEdgeCollector.js';
import { createModuleLevelLiteralVisitor } from './handlers/LiteralHandler.js';
import { analyzeFunctionBody } from './analyzeFunctionBody.js';
import type { ASTCollections } from './types.js';

const traverse = getTraverseFunction(traverseModule);

/**
 * Extract AST collections from a single file.
 *
 * Pure function: reads file, parses with Babel, runs all 14 visitors/traversals,
 * resolves ID collisions, and returns serializable ASTCollections.
 *
 * @param filePath - Absolute path for fs.readFileSync
 * @param relativeFile - Relative path (module.file) for ScopeTracker/semantic IDs
 * @param moduleId - Module ID for node ID generation
 * @param moduleName - Module display name
 * @returns ASTCollections ready for GraphBuilder.build()
 */
export function extractModuleCollections(
  filePath: string,
  relativeFile: string,
  moduleId: string,
  moduleName: string,
): ASTCollections {
  const code = readFileSync(filePath, 'utf-8');

  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript', 'decorators-legacy'],
  });

  const module = { id: moduleId, file: relativeFile, name: moduleName };

  // Create ScopeTracker for semantic ID generation
  // Use relativeFile (relative path from workspace root) for consistent file references
  const scopeTracker = new ScopeTracker(relativeFile);

  // REG-464: Shared IdGenerator for v2 collision resolution across visitors
  const sharedIdGenerator = new IdGenerator(scopeTracker);

  // Initialize all collection arrays and counter refs
  const allCollections = createCollections(module, scopeTracker, code);

  // Imports/Exports
  const importExportVisitor = new ImportExportVisitor(
    module,
    { imports: allCollections.imports, exports: allCollections.exports },
    extractNamesFromPattern
  );
  traverse(ast, importExportVisitor.getImportHandlers());
  traverse(ast, importExportVisitor.getExportHandlers());

  // Variables
  const variableVisitor = new VariableVisitor(
    module,
    {
      variableDeclarations: allCollections.variableDeclarations,
      classInstantiations: allCollections.classInstantiations,
      literals: allCollections.literals,
      variableAssignments: allCollections.variableAssignments,
      varDeclCounterRef: allCollections.varDeclCounterRef,
      literalCounterRef: allCollections.literalCounterRef,
      scopes: allCollections.scopes,
      scopeCounterRef: allCollections.scopeCounterRef,
      objectLiterals: allCollections.objectLiterals,
      objectProperties: allCollections.objectProperties,
      objectLiteralCounterRef: allCollections.objectLiteralCounterRef,
      arrayLiterals: allCollections.arrayLiterals,
      arrayLiteralCounterRef: allCollections.arrayLiteralCounterRef,
    },
    extractNamesFromPattern,
    trackVariableAssignmentFn as TrackVariableAssignmentCallback,
    scopeTracker
  );
  traverse(ast, variableVisitor.getHandlers());

  // Functions
  const functionVisitor = new FunctionVisitor(
    module,
    allCollections,
    analyzeFunctionBody,
    scopeTracker
  );
  traverse(ast, functionVisitor.getHandlers());

  // AssignmentExpression (module-level function assignments)
  traverse(ast, createModuleLevelAssignmentVisitor({
    module,
    scopeTracker,
    functions: allCollections.functions,
    scopes: allCollections.scopes,
    allCollections,
    arrayMutations: allCollections.arrayMutations,
    objectMutations: allCollections.objectMutations,
    analyzeFunctionBody,
  }));

  // Module-level UpdateExpression (obj.count++, arr[i]++, i++) - REG-288/REG-312
  traverse(ast, {
    UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
      // Skip if inside a function - analyzeFunctionBody handles those
      const functionParent = updatePath.getFunctionParent();
      if (functionParent) return;

      // Module-level update expression: no parentScopeId
      collectUpdateExpressionFn(updatePath.node, module, allCollections.updateExpressions, undefined, scopeTracker);
    }
  });

  // Classes
  const classVisitor = new ClassVisitor(
    module,
    allCollections,
    analyzeFunctionBody,
    scopeTracker,
    trackVariableAssignmentFn as TrackVariableAssignmentCallback  // REG-570
  );
  traverse(ast, classVisitor.getHandlers());

  // TypeScript-specific constructs (interfaces, type aliases, enums)
  const typescriptVisitor = new TypeScriptVisitor(module, allCollections, scopeTracker);
  traverse(ast, typescriptVisitor.getHandlers());

  // Module-level callbacks
  traverse(ast, createModuleLevelCallbackVisitor({
    module,
    scopeTracker,
    functions: allCollections.functions,
    scopes: allCollections.scopes,
    allCollections,
    analyzeFunctionBody,
  }));

  // Call expressions
  const callExpressionVisitor = new CallExpressionVisitor(module, allCollections, scopeTracker, sharedIdGenerator);
  traverse(ast, callExpressionVisitor.getHandlers());

  // REG-297: Detect top-level await expressions
  let hasTopLevelAwait = false;
  traverse(ast, {
    AwaitExpression(awaitPath: NodePath<t.AwaitExpression>) {
      if (!awaitPath.getFunctionParent()) {
        hasTopLevelAwait = true;
        awaitPath.stop();
      }
    },
    // for-await-of uses ForOfStatement.await, not AwaitExpression
    ForOfStatement(forOfPath: NodePath<t.ForOfStatement>) {
      if (forOfPath.node.await && !forOfPath.getFunctionParent()) {
        hasTopLevelAwait = true;
        forOfPath.stop();
      }
    }
  });

  // Property access expressions (REG-395)
  const propertyAccessVisitor = new PropertyAccessVisitor(module, allCollections, scopeTracker);
  traverse(ast, propertyAccessVisitor.getHandlers());

  // Module-level NewExpression (constructor calls)
  // This handles top-level code like `const x = new Date()` that's not inside a function
  traverse(ast, createModuleLevelNewExpressionVisitor({
    module,
    scopeTracker,
    constructorCalls: allCollections.constructorCalls,
    callArguments: allCollections.callArguments,
    literals: allCollections.literals,
    literalCounterRef: allCollections.literalCounterRef,
    allCollections: allCollections as unknown as Record<string, unknown>,
    promiseExecutorContexts: allCollections.promiseExecutorContexts,
  }));

  // Module-level IfStatements
  traverse(ast, createModuleLevelIfStatementVisitor({
    module,
    scopeTracker,
    scopes: allCollections.scopes,
    ifScopeCounterRef: allCollections.ifScopeCounterRef,
    code,
  }));

  // REG-579: Collect misc edge types (AWAITS, CHAINS_FROM, DEFAULTS_TO, etc.)
  traverse(ast, createMiscEdgeHandlers({
    file: relativeFile,
    moduleId,
    miscEdges: allCollections.miscEdges,
    miscNodes: allCollections.miscNodes,
    scopeTracker,
    typeNodeCounter: 0,
    functionIds: new Map(),
    parameterIds: new Map(),
    variableIds: new Map(),
    callIds: new Map(),
  }) as unknown as TraverseOptions);

  // Universal LITERAL visitor: creates LITERAL nodes for every literal
  // in the AST that wasn't already captured by specific extractors.
  // Must run AFTER all other visitors so position-based dedup works correctly.
  traverse(ast, createModuleLevelLiteralVisitor(
    module,
    allCollections.literals,
    allCollections.literalCounterRef
  ) as TraverseOptions);

  // REG-464: Resolve v2 ID collisions after all visitors complete
  const pendingNodes = sharedIdGenerator.getPendingNodes();
  if (pendingNodes.length > 0) {
    // Capture pre-resolution IDs to update callArguments afterward
    const preResolutionIds = new Map<{ id: string }, string>();
    for (const pn of pendingNodes) {
      preResolutionIds.set(pn.collectionRef, pn.collectionRef.id);
    }

    const collisionResolver = new CollisionResolver();
    collisionResolver.resolve(pendingNodes);

    // Update callArgument.callId references that became stale after resolution
    const idRemapping = new Map<string, string>();
    for (const pn of pendingNodes) {
      const oldId = preResolutionIds.get(pn.collectionRef)!;
      if (oldId !== pn.collectionRef.id) {
        idRemapping.set(oldId, pn.collectionRef.id);
      }
    }
    if (idRemapping.size > 0) {
      const callArgs = allCollections.callArguments as Array<{ callId: string }> | undefined;
      if (callArgs) {
        for (const arg of callArgs) {
          const resolved = idRemapping.get(arg.callId);
          if (resolved) {
            arg.callId = resolved;
          }
        }
      }
    }
  }

  return toASTCollections(allCollections, hasTopLevelAwait);
}
