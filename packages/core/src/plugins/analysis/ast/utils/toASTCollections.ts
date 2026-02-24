/**
 * toASTCollections — converts internal AnalysisCollections to the ASTCollections
 * interface expected by GraphBuilder.build().
 *
 * Extracted from JSASTAnalyzer.analyzeModule() (REG-460 step 10).
 */

import type { ASTCollections, RejectionPatternInfo, CatchesFromInfo } from '../types.js';
import type { AnalysisCollections } from './createCollections.js';

/**
 * Assemble the ASTCollections object from the working collections.
 *
 * allCollections is the same object whose arrays are mutated during analysis.
 * Some fields (tryBlocks, catchBlocks, finallyBlocks, propertyAssignments)
 * are lazily created by FunctionBodyContext.ensure(), so we read them from
 * allCollections directly.
 */
export function toASTCollections(
  allCollections: AnalysisCollections,
  hasTopLevelAwait: boolean,
): ASTCollections {
  return {
    functions: allCollections.functions,
    parameters: allCollections.parameters,
    scopes: allCollections.scopes,
    branches: allCollections.branches,
    cases: allCollections.cases,
    loops: allCollections.loops,
    tryBlocks: allCollections.tryBlocks as ASTCollections['tryBlocks'],
    catchBlocks: allCollections.catchBlocks as ASTCollections['catchBlocks'],
    finallyBlocks: allCollections.finallyBlocks as ASTCollections['finallyBlocks'],
    variableDeclarations: allCollections.variableDeclarations,
    callSites: allCollections.callSites,
    methodCalls: allCollections.methodCalls,
    eventListeners: allCollections.eventListeners,
    classInstantiations: allCollections.classInstantiations,
    constructorCalls: allCollections.constructorCalls,
    classDeclarations: allCollections.classDeclarations,
    methodCallbacks: allCollections.methodCallbacks,
    callArguments: allCollections.callArguments,
    imports: allCollections.imports,
    exports: allCollections.exports,
    httpRequests: allCollections.httpRequests,
    literals: allCollections.literals,
    variableAssignments: allCollections.variableAssignments,
    interfaces: allCollections.interfaces,
    typeAliases: allCollections.typeAliases,
    enums: allCollections.enums,
    decorators: allCollections.decorators,
    typeParameters: allCollections.typeParameters,
    objectLiterals: allCollections.objectLiterals,
    objectProperties: allCollections.objectProperties,
    arrayLiterals: allCollections.arrayLiterals,
    arrayMutations: allCollections.arrayMutations,
    objectMutations: allCollections.objectMutations,
    propertyAssignments: allCollections.propertyAssignments,
    variableReassignments: allCollections.variableReassignments,
    returnStatements: allCollections.returnStatements,
    updateExpressions: allCollections.updateExpressions,
    promiseResolutions: allCollections.promiseResolutions,
    yieldExpressions: allCollections.yieldExpressions,
    rejectionPatterns: Array.isArray(allCollections.rejectionPatterns)
      ? allCollections.rejectionPatterns as RejectionPatternInfo[]
      : undefined,
    catchesFromInfos: Array.isArray(allCollections.catchesFromInfos)
      ? allCollections.catchesFromInfos as CatchesFromInfo[]
      : undefined,
    propertyAccesses: allCollections.propertyAccesses,
    hasTopLevelAwait,
  };
}
