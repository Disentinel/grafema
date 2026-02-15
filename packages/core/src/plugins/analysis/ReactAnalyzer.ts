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
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type { Node, CallExpression, JSXElement, JSXAttribute, VariableDeclarator, FunctionDeclaration } from '@babel/types';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord, AnyBrandedNode } from '@grafema/types';
import { NodeFactory } from '../../core/NodeFactory.js';
import { getLine, getColumn } from './ast/utils/location.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import { REACT_HOOKS } from './react-internal/types.js';
import type {
  ComponentNode,
  AnalysisResult, AnalysisStats,
} from './react-internal/types.js';
import { analyzeBrowserAPI } from './react-internal/browser-api.js';
import {
  isReactComponent, analyzeJSXElement, analyzeJSXAttribute,
  analyzeForwardRef, analyzeCreateContext,
} from './react-internal/jsx.js';
import { analyzeHook, checkEffectIssues } from './react-internal/hooks.js';

const traverse = (traverseModule as any).default || traverseModule;

export class ReactAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ReactAnalyzer',
      phase: 'ANALYSIS',
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
      const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';
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
          const result = await this.analyzeModule(module, graph, projectPath);
          stats.components += result.components;
          stats.hooks += result.hooks;
          stats.events += result.events;
          stats.browserAPIs += result.browserAPIs;
          stats.issues += result.issues;
          stats.edges += result.edges;
        } catch {
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
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  private isReactFile(filePath: string): boolean {
    if (filePath.endsWith('.jsx') || filePath.endsWith('.tsx')) {
      return true;
    }
    // Could also check for React import in .js/.ts files
    return false;
  }

  private async analyzeModule(module: NodeRecord, graph: PluginContext['graph'], projectPath: string): Promise<AnalysisStats> {
    const code = readFileSync(resolveNodeFile(module.file!, projectPath), 'utf-8');
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
        if (isReactComponent(path)) {
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
        if (isReactComponent(path)) {
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
          const hookData = analyzeHook(path, filePath);
          if (hookData) {
            analysis.hooks.push(hookData);

            // Check for issues in hooks
            if (callee.name === 'useEffect' || callee.name === 'useLayoutEffect') {
              checkEffectIssues(path, filePath, analysis, hookData, importedIdentifiers);
            }
          }
        }

        // Detect forwardRef
        if (callee.type === 'Identifier' && callee.name === 'forwardRef') {
          analyzeForwardRef(path, filePath, analysis);
        }

        // Detect createContext
        if (callee.type === 'Identifier' && callee.name === 'createContext') {
          analyzeCreateContext(path, filePath, analysis);
        }

        // Detect browser APIs
        analyzeBrowserAPI(path, filePath, analysis);
      },

      // JSX elements
      JSXElement: (path: NodePath<JSXElement>) => {
        analyzeJSXElement(path, filePath, analysis);
      },

      // JSX attributes (for event handlers and props)
      JSXAttribute: (path: NodePath<JSXAttribute>) => {
        analyzeJSXAttribute(path, filePath, analysis);
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
   * Add all analysis results to graph
   */
  private async addToGraph(
    analysis: AnalysisResult,
    graph: PluginContext['graph'],
    moduleId: string | null
  ): Promise<void> {
    const nodes: AnyBrandedNode[] = [];
    const edges: Array<{ type: string; src: string; dst: string; [key: string]: unknown }> = [];

    // Collect component nodes and DEFINES edges
    for (const component of analysis.components) {
      nodes.push(NodeFactory.createReactNode(component));
      if (moduleId) {
        edges.push({
          type: 'DEFINES',
          src: moduleId,
          dst: component.id
        });
      }
    }

    // Collect hook nodes
    for (const hook of analysis.hooks) {
      nodes.push(NodeFactory.createReactNode(hook));
    }

    // Collect event nodes
    for (const event of analysis.events) {
      nodes.push(NodeFactory.createReactNode(event));
    }

    // Collect browser API nodes
    for (const api of analysis.browserAPIs) {
      nodes.push(NodeFactory.createReactNode(api));
    }

    // Collect issue nodes
    for (const issue of analysis.issues) {
      nodes.push(NodeFactory.createReactNode(issue));
    }

    // Collect edges from analysis
    for (const edge of analysis.edges) {
      const { edgeType, ...rest } = edge;
      edges.push({
        type: edgeType,
        ...rest
      });
    }

    // Batch write to graph
    await graph.addNodes(nodes);
    await graph.addEdges(edges);
  }
}
