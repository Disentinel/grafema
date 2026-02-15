/**
 * React hooks analysis and issue detection.
 *
 * Analyzes React hooks (useState, useEffect, useCallback, useMemo, useRef,
 * useReducer, useContext, useImperativeHandle) and detects issues like
 * stale closures, missing cleanup, and RAF leaks.
 *
 * @module react-internal/hooks
 */
import type { NodePath } from '@babel/traverse';
import type { Node, CallExpression } from '@babel/types';
import { getLine, getColumn } from '../ast/utils/location.js';
import { getMemberExpressionName } from '../ast/utils/getMemberExpressionName.js';
import { getExpressionValue } from '../ast/utils/getExpressionValue.js';
import { BROWSER_APIS } from './types.js';
import type { HookNode, IssueNode, AnalysisResult } from './types.js';

/**
 * Analyze a React hook call and return a HookNode with extracted metadata.
 *
 * Handles: useState, useEffect, useLayoutEffect, useInsertionEffect,
 * useCallback, useMemo, useRef, useReducer, useContext, useImperativeHandle.
 *
 * Returns null if the hook call cannot be fully analyzed (e.g. non-standard patterns).
 */
export function analyzeHook(path: NodePath<CallExpression>, filePath: string): HookNode | null {
  const callee = path.node.callee as { name: string };
  const hookName = callee.name;
  const args = path.node.arguments;

  const hookBase = {
    file: filePath,
    line: getLine(path.node),
    column: getColumn(path.node),
    hookName
  };

  switch (hookName) {
    case 'useState': {
      // const [state, setState] = useState(initialValue)
      const parent = path.parent as { type: string; id?: { type: string; elements?: Array<{ name?: string }> } };
      if (parent.type === 'VariableDeclarator' &&
          parent.id?.type === 'ArrayPattern' &&
          parent.id.elements?.length === 2) {
        const stateName = parent.id.elements[0]?.name;
        const setterName = parent.id.elements[1]?.name;
        const initialValue = args[0];

        return {
          id: `react:state#${stateName}#${filePath}:${hookBase.line}`,
          type: 'react:state',
          ...hookBase,
          stateName,
          setterName,
          initialValue: getExpressionValue(initialValue as Node)
        };
      }
      break;
    }

    case 'useEffect':
    case 'useLayoutEffect':
    case 'useInsertionEffect': {
      // useEffect(() => {...}, [deps])
      const callback = args[0];
      const depsArg = args[1];
      const deps = extractDeps(depsArg as Node);
      const hasCleanup = hasCleanupReturn(callback as Node);

      const effectType = hookName === 'useEffect' ? 'react:effect' :
                        hookName === 'useLayoutEffect' ? 'react:layout-effect' :
                        'react:insertion-effect';

      return {
        id: `${effectType}#${filePath}:${hookBase.line}`,
        type: effectType,
        ...hookBase,
        deps,
        hasCleanup,
        depsType: !depsArg ? 'none' : (deps?.length === 0 ? 'empty' : 'array')
      };
    }

    case 'useCallback': {
      // const fn = useCallback(() => {...}, [deps])
      const parent = path.parent as { type: string; id?: { name: string } };
      const callbackName = parent.type === 'VariableDeclarator' ? parent.id?.name : null;
      const depsArg = args[1];
      const deps = extractDeps(depsArg as Node);

      return {
        id: `react:callback#${callbackName || 'anonymous'}#${filePath}:${hookBase.line}`,
        type: 'react:callback',
        ...hookBase,
        callbackName,
        deps
      };
    }

    case 'useMemo': {
      // const value = useMemo(() => computation, [deps])
      const parent = path.parent as { type: string; id?: { name: string } };
      const memoName = parent.type === 'VariableDeclarator' ? parent.id?.name : null;
      const depsArg = args[1];
      const deps = extractDeps(depsArg as Node);

      return {
        id: `react:memo#${memoName || 'anonymous'}#${filePath}:${hookBase.line}`,
        type: 'react:memo',
        ...hookBase,
        memoName,
        deps
      };
    }

    case 'useRef': {
      // const ref = useRef(initialValue)
      const parent = path.parent as { type: string; id?: { name: string } };
      const refName = parent.type === 'VariableDeclarator' ? parent.id?.name : null;
      const initialValue = args[0];

      return {
        id: `react:ref#${refName || 'anonymous'}#${filePath}:${hookBase.line}`,
        type: 'react:ref',
        ...hookBase,
        refName,
        initialValue: getExpressionValue(initialValue as Node)
      };
    }

    case 'useReducer': {
      // const [state, dispatch] = useReducer(reducer, initialState)
      const parent = path.parent as { type: string; id?: { type: string; elements?: Array<{ name?: string }> } };
      if (parent.type === 'VariableDeclarator' &&
          parent.id?.type === 'ArrayPattern' &&
          parent.id.elements && parent.id.elements.length >= 2) {
        const stateName = parent.id.elements[0]?.name;
        const dispatchName = parent.id.elements[1]?.name;
        const reducerArg = args[0] as Node | undefined;
        const reducerName = reducerArg?.type === 'Identifier' ? (reducerArg as { name: string }).name : null;

        return {
          id: `react:reducer#${stateName}#${filePath}:${hookBase.line}`,
          type: 'react:reducer',
          ...hookBase,
          stateName,
          dispatchName,
          reducerName
        };
      }
      break;
    }

    case 'useContext': {
      // const value = useContext(Context)
      const parent = path.parent as { type: string; id?: { name: string } };
      const valueName = parent.type === 'VariableDeclarator' ? parent.id?.name : null;
      const contextArg = args[0] as Node | undefined;
      const contextName = contextArg?.type === 'Identifier' ? (contextArg as { name: string }).name : null;

      return {
        id: `react:context-use#${contextName || 'unknown'}#${filePath}:${hookBase.line}`,
        type: 'react:context-use',
        ...hookBase,
        valueName,
        contextName
      };
    }

    case 'useImperativeHandle': {
      // useImperativeHandle(ref, () => ({ method1, method2 }), [deps])
      const refArg = args[0] as Node | undefined;
      const refName = refArg?.type === 'Identifier' ? (refArg as { name: string }).name : null;
      const createHandle = args[1] as Node | undefined;

      // Extract exposed methods
      const exposedMethods: string[] = [];
      if (createHandle?.type === 'ArrowFunctionExpression' ||
          createHandle?.type === 'FunctionExpression') {
        const body = (createHandle as { body: Node }).body;
        if (body.type === 'ObjectExpression') {
          const objExpr = body as { properties: Array<{ key?: { name: string } }> };
          for (const prop of objExpr.properties) {
            if (prop.key?.name) {
              exposedMethods.push(prop.key.name);
            }
          }
        }
      }

      return {
        id: `react:imperative-handle#${filePath}:${hookBase.line}`,
        type: 'react:imperative-handle',
        ...hookBase,
        refName,
        exposedMethods
      };
    }
  }

  return null;
}

/**
 * Check for issues in useEffect/useLayoutEffect callbacks.
 *
 * Detects:
 * - Stale closures: variables used in effect but not in dependency array
 * - Missing cleanup: timers, WebSockets, observers without cleanup return
 * - RAF leaks: requestAnimationFrame without cancelAnimationFrame
 */
export function checkEffectIssues(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult,
  hookData: HookNode,
  importedIdentifiers: Set<string> = new Set()
): void {
  const callback = path.node.arguments[0];
  if (!callback) return;

  const deps = hookData.deps as string[] | null;
  const usedVars = new Set<string>();
  const setterCalls = new Set<string>();
  const callbackParams = new Set<string>(); // Track parameters of nested callback functions

  // Simple recursive AST walker to collect identifiers
  const collectIdentifiers = (node: Node | null, _parentType: string | null = null, isPropertyKey = false): void => {
    if (!node) return;

    if (node.type === 'Identifier') {
      const id = node as { name: string };
      // Skip if it's a property access key
      if (!isPropertyKey && !callbackParams.has(id.name)) {
        usedVars.add(id.name);
      }
      return;
    }

    if (node.type === 'MemberExpression') {
      const memExpr = node as { object: Node; property: { type: string; name?: string } };
      // Check for ref.current pattern (valid for stable refs)
      if (memExpr.property?.type === 'Identifier' && memExpr.property.name === 'current') {
        // This is likely a ref.current access - collect only the ref name, not 'current'
        collectIdentifiers(memExpr.object, 'MemberExpression', false);
        return;
      }
      collectIdentifiers(memExpr.object, 'MemberExpression', false);
      // Skip property name
      return;
    }

    if (node.type === 'CallExpression') {
      const callExpr = node as { callee: Node & { name?: string }; arguments: Node[] };
      const callee = callExpr.callee;
      if (callee.type === 'Identifier' && callee.name?.startsWith('set')) {
        const arg = callExpr.arguments[0];
        if (arg?.type === 'ArrowFunctionExpression' ||
            arg?.type === 'FunctionExpression') {
          setterCalls.add(callee.name);
        }
      }
      collectIdentifiers(callee, 'CallExpression', false);
      callExpr.arguments?.forEach(arg => collectIdentifiers(arg, 'CallExpression', false));
      return;
    }

    if (node.type === 'ObjectProperty') {
      const prop = node as { value: Node };
      // Skip key, process value
      collectIdentifiers(prop.value, 'ObjectProperty', false);
      return;
    }

    // Handle function parameters - skip them (AC-1: callback parameters are not external deps)
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      const func = node as { params?: Array<{ type: string; name?: string }>; body: Node };
      // Collect parameter names from nested callbacks
      func.params?.forEach(p => {
        if (p.type === 'Identifier' && p.name) {
          callbackParams.add(p.name); // Add to global tracking
        }
      });

      const collectInBody = (bodyNode: Node | null): void => {
        if (!bodyNode) return;
        if (bodyNode.type === 'Identifier') {
          const id = bodyNode as { name: string };
          if (!callbackParams.has(id.name)) {
            usedVars.add(id.name);
          }
        } else if (typeof bodyNode === 'object') {
          Object.values(bodyNode).forEach(child => {
            if (child && typeof child === 'object') {
              if (Array.isArray(child)) {
                child.forEach(c => collectInBody(c as Node));
              } else {
                collectInBody(child as Node);
              }
            }
          });
        }
      };
      collectInBody(func.body);
      return;
    }

    // Recurse into child nodes
    if (typeof node === 'object') {
      Object.entries(node).forEach(([key, child]) => {
        if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') return;
        if (child && typeof child === 'object') {
          if (Array.isArray(child)) {
            child.forEach(c => collectIdentifiers(c as Node, node.type, false));
          } else {
            collectIdentifiers(child as Node, node.type, false);
          }
        }
      });
    }
  };

  collectIdentifiers(callback as Node);

  // Check for stale closures
  if (deps !== null && deps.length >= 0) { // Has deps array
    const depsSet = new Set(deps);

    // Hooks that don't cause stale closure issues
    const safeHooks = ['useState', 'useReducer', 'useRef', 'useCallback', 'useMemo',
                        'useEffect', 'useLayoutEffect', 'useContext'];
    const setterPrefixes = ['set'];

    for (const used of usedVars) {
      // Skip safe identifiers
      if (safeHooks.includes(used)) continue;
      if (setterPrefixes.some(p => used.startsWith(p))) continue;
      if (depsSet.has(used)) continue;
      if (used === 'console' || used === 'window' || used === 'document') continue;
      if (used === 'Math' || used === 'JSON' || used === 'Date') continue;
      if (used === 'undefined' || used === 'null' || used === 'true' || used === 'false') continue;
      // AC-2: Skip imported identifiers (stable references)
      if (importedIdentifiers.has(used)) continue;

      // This variable is used but not in deps - potential stale closure
      const issue: IssueNode = {
        id: `issue:stale-closure#${used}#${filePath}:${hookData.line}`,
        type: 'issue:stale-closure',
        file: filePath,
        line: hookData.line,
        variable: used,
        hookType: hookData.hookName,
        deps: deps,
        message: `Variable '${used}' is used in ${hookData.hookName} but not listed in dependencies`
      };
      analysis.issues.push(issue);
    }
  }

  // Check for missing cleanup
  checkMissingCleanup(callback as Node, filePath, analysis, hookData);
}

// --- Module-internal helpers ---

/**
 * Extract dependency array from a hook's deps argument.
 */
function extractDeps(depsArg: Node | undefined): string[] | null {
  if (!depsArg) return null; // No deps argument
  if (depsArg.type !== 'ArrayExpression') return ['<dynamic>'];

  const arrExpr = depsArg as { elements: Array<Node | null> };
  return arrExpr.elements.map(el => {
    if (!el) return '<empty>';
    if (el.type === 'Identifier') return (el as { name: string }).name;
    if (el.type === 'MemberExpression') {
      return getMemberExpressionName(el);
    }
    return '<expression>';
  });
}

/**
 * Check if an effect callback has a cleanup return statement.
 */
function hasCleanupReturn(callback: Node | undefined): boolean {
  if (!callback) return false;
  if (callback.type !== 'ArrowFunctionExpression' &&
      callback.type !== 'FunctionExpression') {
    return false;
  }

  // Simple AST traversal without using babel traverse
  const checkForCleanupReturn = (node: Node | null): boolean => {
    if (!node) return false;

    if (node.type === 'ReturnStatement') {
      const retStmt = node as { argument?: Node };
      const arg = retStmt.argument;
      if (arg && (arg.type === 'ArrowFunctionExpression' ||
                  arg.type === 'FunctionExpression')) {
        return true;
      }
    }

    // Check body
    const nodeWithBody = node as { body?: Node | Node[] };
    if (nodeWithBody.body) {
      if (Array.isArray(nodeWithBody.body)) {
        return nodeWithBody.body.some(n => checkForCleanupReturn(n));
      } else if (nodeWithBody.body.type === 'BlockStatement') {
        const blockStmt = nodeWithBody.body as { body?: Node[] };
        if (blockStmt.body) {
          return blockStmt.body.some(n => checkForCleanupReturn(n));
        }
      } else {
        return checkForCleanupReturn(nodeWithBody.body);
      }
    }

    return false;
  };

  return checkForCleanupReturn(callback);
}

/**
 * Check for missing cleanup in an effect callback.
 *
 * Detects timers (especially requestAnimationFrame), WebSockets,
 * and observers created without a corresponding cleanup.
 */
function checkMissingCleanup(
  callback: Node,
  filePath: string,
  analysis: AnalysisResult,
  hookData: HookNode
): void {
  const hasCleanup = hookData.hasCleanup as boolean;

  // Simple recursive AST walker
  const checkNode = (node: Node | null, _parent: Node | null = null): void => {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'CallExpression') {
      const callExpr = node as { callee?: { type: string; name?: string }; loc?: { start: { line: number } } };
      const callee = callExpr.callee;
      const loc = callExpr.loc;

      // Check for timer APIs
      if (callee?.type === 'Identifier') {
        const api = callee.name;
        if (api && BROWSER_APIS.timers.includes(api)) {
          // Timer called without storing reference
          if (!hasCleanup && api === 'requestAnimationFrame') {
            analysis.issues.push({
              id: `issue:raf-leak#${filePath}:${loc?.start?.line || 0}`,
              type: 'issue:raf-leak',
              file: filePath,
              line: loc?.start?.line || 0,
              message: `requestAnimationFrame called without cleanup - will leak on unmount`
            });
          }
        }
      }
    }

    if (node.type === 'NewExpression') {
      const newExpr = node as { callee?: { type: string; name?: string }; loc?: { start: { line: number } } };
      const callee = newExpr.callee;
      const loc = newExpr.loc;

      // Check for WebSocket without cleanup
      if (callee?.type === 'Identifier' && callee.name === 'WebSocket') {
        if (!hasCleanup) {
          analysis.issues.push({
            id: `issue:missing-cleanup#websocket#${filePath}:${loc?.start?.line || 0}`,
            type: 'issue:missing-cleanup',
            file: filePath,
            line: loc?.start?.line || 0,
            api: 'WebSocket',
            message: `WebSocket created without cleanup - connection will leak on unmount`
          });
        }
      }

      // Check for observers without cleanup
      if (callee?.type === 'Identifier' && callee.name && BROWSER_APIS.observers.includes(callee.name)) {
        if (!hasCleanup) {
          analysis.issues.push({
            id: `issue:missing-cleanup#${callee.name}#${filePath}:${loc?.start?.line || 0}`,
            type: 'issue:missing-cleanup',
            file: filePath,
            line: loc?.start?.line || 0,
            api: callee.name,
            message: `${callee.name} created without disconnect in cleanup`
          });
        }
      }
    }

    // Recurse into child nodes
    Object.entries(node).forEach(([key, child]) => {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') return;
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) {
          child.forEach(c => checkNode(c as Node, node));
        } else {
          checkNode(child as Node, node);
        }
      }
    });
  };

  checkNode(callback);
}
