/**
 * ReactAnalyzer - React/Browser domain-specific analysis
 *
 * Detects React patterns:
 * - Components and rendering tree
 * - Props flow between components
 * - Event handlers (onClick, onSubmit, etc.)
 * - Hooks (useState, useEffect, useCallback, useMemo, useRef, useReducer, useContext)
 * - Browser APIs (localStorage, timers, DOM, observers)
 * - Edge cases (stale closures, missing cleanup, RAF bugs)
 */

import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type { Node, CallExpression, JSXElement, JSXAttribute, VariableDeclarator, FunctionDeclaration } from '@babel/types';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { brandNode } from '@grafema/types';
import { getLine, getColumn } from './ast/utils/location.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

// React event handlers mapping
const REACT_EVENTS: Record<string, string> = {
  // Mouse events
  onClick: 'click', onDoubleClick: 'dblclick', onContextMenu: 'contextmenu',
  onMouseDown: 'mousedown', onMouseUp: 'mouseup', onMouseEnter: 'mouseenter',
  onMouseLeave: 'mouseleave', onMouseMove: 'mousemove', onMouseOver: 'mouseover',
  onMouseOut: 'mouseout',
  // Keyboard events
  onKeyDown: 'keydown', onKeyUp: 'keyup', onKeyPress: 'keypress',
  // Focus events
  onFocus: 'focus', onBlur: 'blur', onFocusCapture: 'focus:capture',
  // Form events
  onSubmit: 'submit', onReset: 'reset', onChange: 'change', onInput: 'input',
  onInvalid: 'invalid',
  // Touch events
  onTouchStart: 'touchstart', onTouchMove: 'touchmove', onTouchEnd: 'touchend',
  onTouchCancel: 'touchcancel',
  // Drag events
  onDragStart: 'dragstart', onDrag: 'drag', onDragEnd: 'dragend',
  onDragEnter: 'dragenter', onDragOver: 'dragover', onDragLeave: 'dragleave',
  onDrop: 'drop',
  // Scroll/Wheel events
  onScroll: 'scroll', onWheel: 'wheel',
  // Clipboard events
  onCopy: 'copy', onCut: 'cut', onPaste: 'paste',
  // Composition events
  onCompositionStart: 'compositionstart', onCompositionUpdate: 'compositionupdate',
  onCompositionEnd: 'compositionend',
  // Media events
  onPlay: 'play', onPause: 'pause', onEnded: 'ended', onTimeUpdate: 'timeupdate',
  onLoadedData: 'loadeddata', onLoadedMetadata: 'loadedmetadata',
  onCanPlay: 'canplay', onWaiting: 'waiting', onSeeking: 'seeking',
  onSeeked: 'seeked', onError: 'error', onVolumeChange: 'volumechange',
  // Image events
  onLoad: 'load',
  // Animation events
  onAnimationStart: 'animationstart', onAnimationEnd: 'animationend',
  onAnimationIteration: 'animationiteration',
  // Transition events
  onTransitionEnd: 'transitionend',
  // Pointer events
  onPointerDown: 'pointerdown', onPointerUp: 'pointerup', onPointerMove: 'pointermove',
  onPointerEnter: 'pointerenter', onPointerLeave: 'pointerleave',
  onPointerCancel: 'pointercancel', onGotPointerCapture: 'gotpointercapture',
  onLostPointerCapture: 'lostpointercapture'
};

// React hooks that need tracking
const REACT_HOOKS = [
  'useState', 'useEffect', 'useLayoutEffect', 'useInsertionEffect',
  'useCallback', 'useMemo', 'useRef', 'useReducer', 'useContext',
  'useImperativeHandle', 'useDebugValue', 'useDeferredValue',
  'useTransition', 'useId', 'useSyncExternalStore'
];

// Browser APIs that create side effects
const BROWSER_APIS = {
  timers: ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'],
  cleanup: {
    setTimeout: 'clearTimeout',
    setInterval: 'clearInterval',
    requestAnimationFrame: 'cancelAnimationFrame',
    requestIdleCallback: 'cancelIdleCallback'
  } as Record<string, string>,
  observers: ['IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'PerformanceObserver'],
  storage: ['localStorage', 'sessionStorage'],
  async: ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'],
  dom: ['document', 'getElementById', 'querySelector', 'querySelectorAll'],
  workers: ['Worker', 'SharedWorker', 'ServiceWorker'],
  geolocation: ['grafemagator.geolocation'],
  notifications: ['Notification'],
  fullscreen: ['requestFullscreen', 'exitFullscreen'],
  clipboard: ['grafemagator.clipboard'],
  history: ['history.pushState', 'history.replaceState'],
  blocking: ['alert', 'confirm', 'prompt']
};

/**
 * Component node
 */
interface ComponentNode {
  id: string;
  type: 'react:component';
  name: string;
  file: string;
  line: number;
  column: number;
  kind: 'arrow' | 'function' | 'forwardRef';
}

/**
 * Hook node
 */
interface HookNode {
  id: string;
  type: string;
  file: string;
  line: number;
  column: number;
  hookName: string;
  [key: string]: unknown;
}

/**
 * Event node
 */
interface EventNode {
  id: string;
  type: 'dom:event';
  eventType: string;
  reactProp: string;
  handler: string;
  file: string;
  line: number;
}

/**
 * Browser API node
 */
interface BrowserAPINode {
  id: string;
  type: string;
  file: string;
  line: number;
  [key: string]: unknown;
}

/**
 * Issue node
 */
interface IssueNode {
  id: string;
  type: string;
  file: string;
  line: number;
  [key: string]: unknown;
}

/**
 * Edge info
 */
interface EdgeInfo {
  edgeType: string;
  src: string;
  dst: string;
  file: string;
  line: number;
  [key: string]: unknown;
}

/**
 * Analysis result
 */
interface AnalysisResult {
  components: ComponentNode[];
  hooks: HookNode[];
  events: EventNode[];
  browserAPIs: BrowserAPINode[];
  issues: IssueNode[];
  edges: EdgeInfo[];
}

/**
 * Analysis stats
 */
interface AnalysisStats {
  components: number;
  hooks: number;
  events: number;
  browserAPIs: number;
  issues: number;
  edges: number;
  [key: string]: unknown;
}

export class ReactAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ReactAnalyzer',
      phase: 'ANALYSIS',
      priority: 70, // After JSASTAnalyzer and ExpressAnalyzer
      creates: {
        nodes: [
          'react:component', 'react:state', 'react:effect', 'react:callback',
          'react:memo', 'react:ref', 'react:reducer', 'react:context',
          'dom:event', 'browser:storage', 'browser:timer', 'browser:observer',
          'browser:async', 'browser:worker', 'browser:api',
          'canvas:context', 'canvas:draw',
          'issue:stale-closure', 'issue:missing-cleanup', 'issue:raf-leak',
          'issue:canvas-leak', 'issue:state-after-unmount'
        ],
        edges: [
          'RENDERS', 'PASSES_PROP', 'HANDLES_EVENT', 'UPDATES_STATE',
          'DEPENDS_ON', 'SCHEDULES', 'CLEANS_UP', 'DISPATCHES',
          'PROVIDES', 'CONSUMES', 'FORWARDS_REF', 'OBSERVES'
        ]
      },
      dependencies: ['JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;
      const modules = await this.getModules(graph);

      const stats: AnalysisStats = {
        components: 0,
        hooks: 0,
        events: 0,
        browserAPIs: 0,
        issues: 0,
        edges: 0
      };

      for (const module of modules) {
        // Only analyze .jsx, .tsx, or files that import React
        if (!this.isReactFile(module.file!)) {
          continue;
        }

        try {
          const result = await this.analyzeModule(module, graph);
          stats.components += result.components;
          stats.hooks += result.hooks;
          stats.events += result.events;
          stats.browserAPIs += result.browserAPIs;
          stats.issues += result.issues;
          stats.edges += result.edges;
        } catch (err) {
          // Silent - per-module errors shouldn't spam logs
        }
      }

      logger.info('Analysis complete', {
        components: stats.components,
        hooks: stats.hooks,
        events: stats.events,
        issues: stats.issues
      });

      return createSuccessResult(
        {
          nodes: stats.components + stats.hooks + stats.events + stats.browserAPIs + stats.issues,
          edges: stats.edges
        },
        stats
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      return createErrorResult(error as Error);
    }
  }

  private isReactFile(filePath: string): boolean {
    if (filePath.endsWith('.jsx') || filePath.endsWith('.tsx')) {
      return true;
    }
    // Could also check for React import in .js/.ts files
    return false;
  }

  private async analyzeModule(module: NodeRecord, graph: PluginContext['graph']): Promise<AnalysisStats> {
    const code = readFileSync(module.file!, 'utf-8');
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'] as ParserPlugin[]
    });

    return this.analyzeAST(ast, module.file!, graph, module.id);
  }

  /**
   * Main AST analysis - can be called directly for testing
   */
  async analyzeAST(
    ast: Node,
    filePath: string,
    graph: PluginContext['graph'],
    moduleId: string | null = null
  ): Promise<AnalysisStats> {
    const analysis: AnalysisResult = {
      components: [],
      hooks: [],
      events: [],
      browserAPIs: [],
      issues: [],
      edges: []
    };

    const importedIdentifiers = new Set<string>();

    // Collect imported identifiers (stable references)
    traverse(ast, {
      ImportDeclaration: (path: NodePath) => {
        const node = path.node as { specifiers: Array<{ local?: { name: string } }> };
        for (const specifier of node.specifiers) {
          if (specifier.local?.name) {
            importedIdentifiers.add(specifier.local.name);
          }
        }
      }
    });

    // First pass: collect component definitions
    traverse(ast, {
      // Arrow function components: const App = () => ...
      VariableDeclarator: (path: NodePath<VariableDeclarator>) => {
        if (this.isReactComponent(path)) {
          const node = path.node;
          const name = (node.id as { name: string }).name;
          const component: ComponentNode = {
            id: `react:component#${name}#${filePath}:${getLine(node)}`,
            type: 'react:component',
            name,
            file: filePath,
            line: getLine(node),
            column: getColumn(node),
            kind: 'arrow'
          };
          analysis.components.push(component);
        }
      },

      // Function declaration components: function App() {...}
      FunctionDeclaration: (path: NodePath<FunctionDeclaration>) => {
        if (this.isReactComponent(path)) {
          const name = path.node.id?.name;
          if (!name) return;

          const component: ComponentNode = {
            id: `react:component#${name}#${filePath}:${getLine(path.node)}`,
            type: 'react:component',
            name,
            file: filePath,
            line: getLine(path.node),
            column: getColumn(path.node),
            kind: 'function'
          };
          analysis.components.push(component);
        }
      }
    });

    // Second pass: analyze hooks, events, JSX
    traverse(ast, {
      CallExpression: (path: NodePath<CallExpression>) => {
        const callee = path.node.callee;

        // Detect React hooks
        if (callee.type === 'Identifier' && REACT_HOOKS.includes(callee.name)) {
          const hookData = this.analyzeHook(path, filePath);
          if (hookData) {
            analysis.hooks.push(hookData);

            // Check for issues in hooks
            if (callee.name === 'useEffect' || callee.name === 'useLayoutEffect') {
              this.checkEffectIssues(path, filePath, analysis, hookData, importedIdentifiers);
            }
          }
        }

        // Detect forwardRef
        if (callee.type === 'Identifier' && callee.name === 'forwardRef') {
          this.analyzeForwardRef(path, filePath, analysis);
        }

        // Detect createContext
        if (callee.type === 'Identifier' && callee.name === 'createContext') {
          this.analyzeCreateContext(path, filePath, analysis);
        }

        // Detect browser APIs
        this.analyzeBrowserAPI(path, filePath, analysis);
      },

      // JSX elements
      JSXElement: (path: NodePath<JSXElement>) => {
        this.analyzeJSXElement(path, filePath, analysis);
      },

      // JSX attributes (for event handlers and props)
      JSXAttribute: (path: NodePath<JSXAttribute>) => {
        this.analyzeJSXAttribute(path, filePath, analysis);
      }
    });

    // Add all nodes and edges to graph
    await this.addToGraph(analysis, graph, moduleId);

    return {
      components: analysis.components.length,
      hooks: analysis.hooks.length,
      events: analysis.events.length,
      browserAPIs: analysis.browserAPIs.length,
      issues: analysis.issues.length,
      edges: analysis.edges.length
    };
  }

  /**
   * Check if a function is a React component (returns JSX)
   */
  private isReactComponent(path: NodePath): boolean {
    let hasJSXReturn = false;

    // Check for arrow function or function
    const node = path.node as { init?: Node };
    const func = node.init || path.node;
    if (!func) return false;

    // Must be a function
    if (func.type !== 'ArrowFunctionExpression' &&
        func.type !== 'FunctionExpression' &&
        func.type !== 'FunctionDeclaration') {
      return false;
    }

    // Name must start with uppercase (React component convention)
    const pathNode = path.node as { id?: { name: string } };
    const name = pathNode.id?.name;
    if (!name || !/^[A-Z]/.test(name)) {
      return false;
    }

    // Check if body contains JSX
    path.traverse({
      JSXElement: () => { hasJSXReturn = true; },
      JSXFragment: () => { hasJSXReturn = true; }
    });

    return hasJSXReturn;
  }

  /**
   * Analyze React hooks
   */
  private analyzeHook(path: NodePath<CallExpression>, filePath: string): HookNode | null {
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
            initialValue: this.getExpressionValue(initialValue as Node)
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
        const deps = this.extractDeps(depsArg as Node);
        const hasCleanup = this.hasCleanupReturn(callback as Node);

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
        const deps = this.extractDeps(depsArg as Node);

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
        const deps = this.extractDeps(depsArg as Node);

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
          initialValue: this.getExpressionValue(initialValue as Node)
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
   * Extract dependency array from hook
   */
  private extractDeps(depsArg: Node | undefined): string[] | null {
    if (!depsArg) return null; // No deps argument
    if (depsArg.type !== 'ArrayExpression') return ['<dynamic>'];

    const arrExpr = depsArg as { elements: Array<Node | null> };
    return arrExpr.elements.map(el => {
      if (!el) return '<empty>';
      if (el.type === 'Identifier') return (el as { name: string }).name;
      if (el.type === 'MemberExpression') {
        return this.getMemberExpressionName(el);
      }
      return '<expression>';
    });
  }

  private getMemberExpressionName(node: Node): string {
    if (node.type !== 'MemberExpression') {
      return (node as { name?: string }).name || '<unknown>';
    }
    const memExpr = node as { object: Node; property: { name?: string; value?: string } };
    const object = this.getMemberExpressionName(memExpr.object);
    const property = memExpr.property.name || memExpr.property.value || '<computed>';
    return `${object}.${property}`;
  }

  /**
   * Check if effect callback has cleanup return
   */
  private hasCleanupReturn(callback: Node | undefined): boolean {
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
   * Check for issues in useEffect/useLayoutEffect
   */
  private checkEffectIssues(
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
    const collectIdentifiers = (node: Node | null, parentType: string | null = null, isPropertyKey = false): void => {
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
    this.checkMissingCleanup(callback as Node, filePath, analysis, hookData);
  }

  /**
   * Check for missing cleanup in effect callback
   */
  private checkMissingCleanup(
    callback: Node,
    filePath: string,
    analysis: AnalysisResult,
    hookData: HookNode
  ): void {
    const hasCleanup = hookData.hasCleanup as boolean;

    // Simple recursive AST walker
    const checkNode = (node: Node | null, parent: Node | null = null): void => {
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

  /**
   * Analyze JSX element for component rendering
   */
  private analyzeJSXElement(path: NodePath<JSXElement>, filePath: string, analysis: AnalysisResult): void {
    const openingElement = path.node.openingElement;
    const elementName = this.getJSXElementName(openingElement.name);

    // Skip native HTML elements (lowercase)
    if (/^[a-z]/.test(elementName)) {
      return;
    }

    // This is a React component being rendered

    // Find parent component
    let parentComponent: string | null = null;
    let parentPath: NodePath<Node> | null = path.parentPath;
    while (parentPath) {
      if (parentPath.node.type === 'FunctionDeclaration' ||
          parentPath.node.type === 'ArrowFunctionExpression' ||
          parentPath.node.type === 'FunctionExpression') {
        // Check if this function is a component
        const funcName = this.getFunctionName(parentPath);
        if (funcName && /^[A-Z]/.test(funcName)) {
          parentComponent = funcName;
          break;
        }
      }
      parentPath = parentPath.parentPath;
    }

    if (parentComponent) {
      analysis.edges.push({
        edgeType: 'RENDERS',
        src: `react:component#${parentComponent}`,
        dst: `react:component#${elementName}`,
        file: filePath,
        line: getLine(openingElement)
      });
    }
  }

  private getJSXElementName(nameNode: Node): string {
    if (nameNode.type === 'JSXIdentifier') {
      return (nameNode as { name: string }).name;
    }
    if (nameNode.type === 'JSXMemberExpression') {
      const memExpr = nameNode as { object: Node; property: { name: string } };
      return `${this.getJSXElementName(memExpr.object)}.${memExpr.property.name}`;
    }
    return '<unknown>';
  }

  private getFunctionName(path: NodePath): string | null {
    // Arrow function assigned to variable
    const parent = path.parent as { type: string; id?: { name: string } };
    if (parent?.type === 'VariableDeclarator') {
      return parent.id?.name || null;
    }
    // Function declaration
    const node = path.node as { id?: { name: string } };
    if (node.id?.name) {
      return node.id.name;
    }
    return null;
  }

  /**
   * Analyze JSX attribute for props and event handlers
   */
  private analyzeJSXAttribute(path: NodePath<JSXAttribute>, filePath: string, analysis: AnalysisResult): void {
    const attr = path.node;
    if (!attr.name || attr.name.type !== 'JSXIdentifier') return;

    const attrName = attr.name.name;

    // Get parent JSX element info first
    const jsxOpeningElement = path.parent as { type: string; name?: Node };
    let componentName: string | null = null;
    let isReactComponent = false;

    if (jsxOpeningElement?.type === 'JSXOpeningElement' && jsxOpeningElement.name) {
      componentName = this.getJSXElementName(jsxOpeningElement.name);
      isReactComponent = /^[A-Z]/.test(componentName);
    }

    // Check if it's an event handler
    if (REACT_EVENTS[attrName]) {
      const eventType = REACT_EVENTS[attrName];
      const handler = attr.value as { type: string; expression?: Node } | null;

      let handlerName = '<inline>';
      if (handler?.type === 'JSXExpressionContainer') {
        const expr = handler.expression;
        if (expr?.type === 'Identifier') {
          handlerName = (expr as { name: string }).name;
        } else if (expr?.type === 'MemberExpression') {
          handlerName = this.getMemberExpressionName(expr);
        }
      }

      const event: EventNode = {
        id: `dom:event#${eventType}#${filePath}:${getLine(attr)}`,
        type: 'dom:event',
        eventType,
        reactProp: attrName,
        handler: handlerName,
        file: filePath,
        line: getLine(attr)
      };
      analysis.events.push(event);
    }

    // For React components (uppercase), create PASSES_PROP edges for all props
    if (isReactComponent && componentName && attrName !== 'key' && attrName !== 'ref' && attrName !== 'children') {
      let propValue = '<expression>';
      const value = attr.value as { type: string; value?: string; expression?: Node } | null;
      if (value?.type === 'StringLiteral') {
        propValue = value.value || '';
      } else if (value?.type === 'JSXExpressionContainer') {
        propValue = this.getExpressionValue(value.expression!);
      } else if (value === null) {
        propValue = 'true'; // Boolean shorthand
      }

      // Find parent component
      let parentComponent: string | null = null;
      let parentPath: NodePath | null = path.parentPath;
      while (parentPath) {
        const node = parentPath.node as { type: string; id?: { name: string } };
        if (node.type === 'FunctionDeclaration' && node.id?.name) {
          if (/^[A-Z]/.test(node.id.name)) {
            parentComponent = node.id.name;
            break;
          }
        } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
          const funcName = this.getFunctionName(parentPath);
          if (funcName && /^[A-Z]/.test(funcName)) {
            parentComponent = funcName;
            break;
          }
        }
        parentPath = parentPath.parentPath;
      }

      if (parentComponent) {
        analysis.edges.push({
          edgeType: 'PASSES_PROP',
          src: `react:component#${parentComponent}`,
          dst: `react:component#${componentName}`,
          propName: attrName,
          propValue,
          file: filePath,
          line: getLine(attr)
        });
      }
    }
  }

  /**
   * Analyze forwardRef usage
   */
  private analyzeForwardRef(path: NodePath<CallExpression>, filePath: string, analysis: AnalysisResult): void {
    const parent = path.parent as { type: string; id?: { name: string } };
    const componentName = parent.type === 'VariableDeclarator' ? parent.id?.name : null;

    if (componentName) {
      analysis.components.push({
        id: `react:component#${componentName}#${filePath}:${getLine(path.node)}`,
        type: 'react:component',
        name: componentName,
        file: filePath,
        line: getLine(path.node),
        column: getColumn(path.node),
        kind: 'forwardRef'
      });
    }
  }

  /**
   * Analyze createContext usage
   */
  private analyzeCreateContext(path: NodePath<CallExpression>, filePath: string, analysis: AnalysisResult): void {
    const parent = path.parent as { type: string; id?: { name: string } };
    const contextName = parent.type === 'VariableDeclarator' ? parent.id?.name : null;

    if (contextName) {
      const defaultValue = path.node.arguments[0];
      analysis.hooks.push({
        id: `react:context#${contextName}#${filePath}:${getLine(path.node)}`,
        type: 'react:context',
        contextName,
        file: filePath,
        line: getLine(path.node),
        column: getColumn(path.node),
        hookName: 'createContext',
        defaultValue: this.getExpressionValue(defaultValue as Node)
      });
    }
  }

  /**
   * Analyze browser API calls
   */
  private analyzeBrowserAPI(path: NodePath<CallExpression>, filePath: string, analysis: AnalysisResult): void {
    const callee = path.node.callee;

    // Direct function call: setTimeout, fetch, alert
    if (callee.type === 'Identifier') {
      const name = callee.name;

      // Timers
      if (BROWSER_APIS.timers.includes(name)) {
        analysis.browserAPIs.push({
          id: `browser:timer#${name}#${filePath}:${getLine(path.node)}`,
          type: 'browser:timer',
          api: name,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // Blocking APIs
      if (BROWSER_APIS.blocking.includes(name)) {
        analysis.browserAPIs.push({
          id: `browser:blocking#${name}#${filePath}:${getLine(path.node)}`,
          type: 'browser:blocking',
          api: name,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // Fetch
      if (name === 'fetch') {
        analysis.browserAPIs.push({
          id: `browser:async#fetch#${filePath}:${getLine(path.node)}`,
          type: 'browser:async',
          api: 'fetch',
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }
    }

    // Member expression: localStorage.setItem, document.querySelector
    if (callee.type === 'MemberExpression') {
      const fullName = this.getMemberExpressionName(callee);

      // localStorage/sessionStorage
      if (fullName.startsWith('localStorage.') || fullName.startsWith('sessionStorage.')) {
        const [storage, method] = fullName.split('.');
        const operation = method === 'getItem' ? 'read' :
                         method === 'setItem' ? 'write' :
                         method === 'removeItem' ? 'delete' : method;

        analysis.browserAPIs.push({
          id: `browser:storage#${storage}:${operation}#${filePath}:${getLine(path.node)}`,
          type: 'browser:storage',
          storage,
          operation,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // DOM queries
      if (fullName.startsWith('document.') &&
          (fullName.includes('querySelector') || fullName.includes('getElementById'))) {
        analysis.browserAPIs.push({
          id: `browser:dom#query#${filePath}:${getLine(path.node)}`,
          type: 'browser:dom',
          operation: 'query',
          api: fullName,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // History API
      if (fullName.startsWith('history.') || fullName.startsWith('window.history.')) {
        analysis.browserAPIs.push({
          id: `browser:history#${filePath}:${getLine(path.node)}`,
          type: 'browser:history',
          api: fullName,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // Clipboard API
      if (fullName.includes('clipboard')) {
        analysis.browserAPIs.push({
          id: `browser:clipboard#${filePath}:${getLine(path.node)}`,
          type: 'browser:clipboard',
          api: fullName,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // Geolocation
      if (fullName.includes('geolocation')) {
        analysis.browserAPIs.push({
          id: `browser:geolocation#${filePath}:${getLine(path.node)}`,
          type: 'browser:geolocation',
          api: fullName,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // Canvas context
      if (fullName.match(/\.(fillRect|strokeRect|fillText|strokeText|beginPath|closePath|moveTo|lineTo|arc|fill|stroke|clearRect|drawImage|save|restore|translate|rotate|scale)$/)) {
        const method = fullName.split('.').pop();
        analysis.browserAPIs.push({
          id: `canvas:draw#${method}#${filePath}:${getLine(path.node)}`,
          type: 'canvas:draw',
          method,
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }

      // matchMedia
      if (fullName === 'window.matchMedia' || fullName === 'matchMedia') {
        analysis.browserAPIs.push({
          id: `browser:media-query#${filePath}:${getLine(path.node)}`,
          type: 'browser:media-query',
          api: 'matchMedia',
          file: filePath,
          line: getLine(path.node)
        });
        return;
      }
    }
  }

  private getExpressionValue(expr: Node | undefined): string {
    if (!expr) return 'undefined';
    if (expr.type === 'StringLiteral') return `"${(expr as { value: string }).value}"`;
    if (expr.type === 'NumericLiteral') return String((expr as { value: number }).value);
    if (expr.type === 'BooleanLiteral') return String((expr as { value: boolean }).value);
    if (expr.type === 'NullLiteral') return 'null';
    if (expr.type === 'Identifier') return (expr as { name: string }).name;
    if (expr.type === 'ObjectExpression') return '{...}';
    if (expr.type === 'ArrayExpression') return '[...]';
    if (expr.type === 'ArrowFunctionExpression') return '() => {...}';
    if (expr.type === 'FunctionExpression') return 'function() {...}';
    return '<expression>';
  }

  /**
   * Add all analysis results to graph
   */
  private async addToGraph(
    analysis: AnalysisResult,
    graph: PluginContext['graph'],
    moduleId: string | null
  ): Promise<void> {
    // Add component nodes
    for (const component of analysis.components) {
      await graph.addNode(brandNode({
        id: component.id,
        type: 'react:component' as const,
        name: component.name,
        file: component.file,
        line: component.line,
        column: component.column,
        kind: component.kind
      }));
      if (moduleId) {
        await graph.addEdge({
          type: 'DEFINES',
          src: moduleId,
          dst: component.id
        });
      }
    }

    // Add hook nodes
    for (const hook of analysis.hooks) {
      // Extract all hook properties except those we explicitly set
      const { id, type, file, line, column, hookName, ...restHook } = hook;
      await graph.addNode(brandNode({
        id,
        type,
        name: hookName,
        file,
        line,
        column,
        hookName,
        ...restHook
      }));
    }

    // Add event nodes
    for (const event of analysis.events) {
      await graph.addNode(brandNode({
        id: event.id,
        type: 'dom:event' as const,
        name: event.eventType,
        file: event.file,
        line: event.line,
        eventType: event.eventType,
        reactProp: event.reactProp,
        handler: event.handler
      }));
    }

    // Add browser API nodes
    for (const api of analysis.browserAPIs) {
      const { id, type, file, line, ...restApi } = api;
      await graph.addNode(brandNode({
        id,
        type,
        name: (api as { api?: string }).api || type,
        file,
        line,
        ...restApi
      }));
    }

    // Add issue nodes
    for (const issue of analysis.issues) {
      const { id, type, file, line, ...restIssue } = issue;
      await graph.addNode(brandNode({
        id,
        type,
        name: (issue as { variable?: string }).variable || type,
        file,
        line,
        ...restIssue
      }));
    }

    // Add edges
    for (const edge of analysis.edges) {
      const { edgeType, ...rest } = edge;
      await graph.addEdge({
        type: edgeType,
        ...rest
      });
    }
  }
}
