/**
 * PrefixEvaluator - ENRICHMENT plugin for evaluating dynamic prefixes
 *
 * Resolves placeholders in MOUNT_POINT.prefix:
 * - ${variable} → finds VariableDeclaration in the same module
 * - ${binary} → recursively resolves BinaryExpression
 * - ${template} → resolves TemplateLiteral with variables
 * - ${member} → finds object and its property
 * - ${call} → not supported yet (requires runtime eval)
 * - ${conditional} → not supported yet (requires runtime eval)
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginMetadata, PluginContext, PluginResult } from '../Plugin.js';
import { parse } from '@babel/parser';
import type { ParseResult, ParserPlugin } from '@babel/parser';
import _traverse from '@babel/traverse';
import type {
  File,
  Node,
  CallExpression,
  MemberExpression,
  BinaryExpression,
  TemplateLiteral,
  Identifier,
  StringLiteral,
  ObjectExpression,
  ObjectProperty,
  ArrayExpression,
  VariableDeclarator,
  NumericLiteral
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { readFileSync } from 'fs';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import type { NodeRecord } from '@grafema/types';

// ES module compatibility - handle default export
const traverseFn = (_traverse as unknown as { default: typeof _traverse }).default || _traverse;
const traverse = traverseFn as unknown as (
  ast: Node | null | undefined,
  opts: Record<string, unknown>
) => void;

interface MountPointNode {
  id: string;
  type: 'MOUNT_POINT';
  name: string;
  file: string;
  line: number;
  prefix: string;
  evaluated?: boolean;
}

interface ModuleNode {
  id: string;
  type: 'MODULE';
  name: string;
  file: string;
  line: number;
}

interface Edge {
  type: string;
  fromId: string;
  dst: string;
  [key: string]: unknown;
}

interface EdgeCriteria {
  type?: string;
  dst?: string;
  [key: string]: unknown;
}

interface Graph {
  nodes: Map<string, NodeRecord> | { get(id: string): NodeRecord | undefined; values(): Iterable<NodeRecord> };
  edges: Map<string, Edge> | { values(): Iterable<Edge> };
}

export class PrefixEvaluator extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'PrefixEvaluator',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: []
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer', 'MountPointResolver'],
      consumes: ['DEFINES'],
      produces: []
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    try {
      const { graph } = context;
      const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';
      const logger = this.log(context);
      const graphTyped = graph as unknown as Graph;

      let mountPointsEvaluated = 0;
      let successfulEvaluations = 0;

      // Find all MOUNT_POINT nodes with placeholder prefixes
      const mountPoints: MountPointNode[] = [];
      if (graphTyped.nodes) {
        const allNodes = await (graphTyped.nodes as Map<string, NodeRecord>).values();
        for (const node of allNodes) {
          // Cast through unknown since node types vary
          const typedNode = node as unknown as MountPointNode;
          if (typedNode.type === 'MOUNT_POINT' && typedNode.prefix && typedNode.prefix.startsWith('${')) {
            mountPoints.push(typedNode);
          }
        }
      }

      logger.info('Found mount points with placeholders', { count: mountPoints.length });

      // For each mount point try to evaluate prefix
      for (const mountPoint of mountPoints) {
        mountPointsEvaluated++;

        // Find MODULE that defines this mount point
        const definesEdges = this.findEdges(graphTyped, {
          type: 'DEFINES',
          dst: mountPoint.id
        });

        if (definesEdges.length === 0) {
          logger.debug('No DEFINES edge for mount point', { mountPointId: mountPoint.id });
          continue;
        }

        const moduleId = definesEdges[0].fromId;
        const module = (graphTyped.nodes as Map<string, NodeRecord>).get(moduleId) as ModuleNode | undefined;

        if (!module || module.type !== 'MODULE') {
          logger.debug('Module not found for mount point', { mountPointId: mountPoint.id });
          continue;
        }

        // Parse module AST
        let ast: ParseResult<File>;
        try {
          const code = readFileSync(resolveNodeFile(module.file, projectPath), 'utf-8');
          ast = parse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'] as ParserPlugin[]
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.debug('Failed to parse file', { file: module.file, error: message });
          continue;
        }

        // Try to evaluate prefix based on placeholder type
        const evaluatedPrefix = await this.evaluatePrefix(
          mountPoint.prefix,
          mountPoint.line,
          ast,
          module
        );

        if (evaluatedPrefix && evaluatedPrefix !== mountPoint.prefix) {
          mountPoint.prefix = evaluatedPrefix;
          mountPoint.evaluated = true;
          successfulEvaluations++;
          logger.debug('Resolved prefix', {
            file: mountPoint.file,
            line: mountPoint.line,
            prefix: evaluatedPrefix
          });
        }
      }

      logger.info('Evaluated mount points', {
        successful: successfulEvaluations,
        total: mountPointsEvaluated
      });

      return createSuccessResult(
        { nodes: 0, edges: 0 },
        { mountPointsEvaluated, successfulEvaluations }
      );

    } catch (error) {
      const logger = this.log(context);
      logger.error('Error in PrefixEvaluator', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  /**
   * Evaluate prefix based on placeholder type
   */
  async evaluatePrefix(
    placeholder: string,
    line: number,
    ast: ParseResult<File>,
    _module: ModuleNode
  ): Promise<string | null> {
    if (placeholder === '${variable}') {
      return this.evaluateVariable(line, ast);
    } else if (placeholder === '${binary}') {
      return this.evaluateBinary(line, ast);
    } else if (placeholder === '${template}') {
      return this.evaluateTemplate(line, ast);
    } else if (placeholder === '${member}') {
      return this.evaluateMember(line, ast);
    }
    // ${call}, ${conditional} - not supported yet
    return null;
  }

  /**
   * Resolve ${variable} - find VariableDeclaration
   */
  evaluateVariable(line: number, ast: ParseResult<File>): string | null {
    let variableName: string | null = null;
    let variableValue: string | null = null;

    // First find app.use() on the target line and get variable name
    traverse(ast, {
      CallExpression: (path: NodePath<CallExpression>) => {
        const node = path.node;
        if (node.loc?.start.line === line) {
          // Check if this is app.use() or router.use()
          if (node.callee.type === 'MemberExpression' &&
              (node.callee.property as Identifier).name === 'use' &&
              node.arguments.length >= 2) {
            const firstArg = node.arguments[0];
            if (firstArg.type === 'Identifier') {
              variableName = firstArg.name;
            }
          }
        }
      }
    });

    if (!variableName) {
      return null;
    }

    // Now find declaration of this variable
    const targetName = variableName;
    traverse(ast, {
      VariableDeclarator: (path: NodePath<VariableDeclarator>) => {
        const node = path.node;
        if (node.id.type === 'Identifier' && node.id.name === targetName) {
          if (node.init && node.init.type === 'StringLiteral') {
            variableValue = (node.init as StringLiteral).value;
          }
        }
      }
    });

    return variableValue;
  }

  /**
   * Resolve ${binary} - BinaryExpression (a + b)
   */
  evaluateBinary(line: number, ast: ParseResult<File>): string | null {
    let binaryExpression: BinaryExpression | null = null;

    // Find app.use() on target line and get BinaryExpression
    traverse(ast, {
      CallExpression: (path: NodePath<CallExpression>) => {
        const node = path.node;
        if (node.loc?.start.line === line) {
          if (node.callee.type === 'MemberExpression' &&
              (node.callee.property as Identifier).name === 'use' &&
              node.arguments.length >= 2) {
            const firstArg = node.arguments[0];
            if (firstArg.type === 'BinaryExpression') {
              binaryExpression = firstArg;
            }
          }
        }
      }
    });

    if (!binaryExpression) {
      return null;
    }

    // Cast to help TypeScript understand the narrowing after closure mutation
    const expr = binaryExpression as BinaryExpression;

    // Recursively resolve both sides of Binary Expression
    const left = this.resolveExpression(expr.left, ast);
    const right = this.resolveExpression(expr.right, ast);

    if (left && right && expr.operator === '+') {
      return left + right;
    }

    return null;
  }

  /**
   * Recursively resolve arbitrary expression
   */
  resolveExpression(node: Node, ast: ParseResult<File>): string | null {
    if (node.type === 'StringLiteral') {
      return (node as StringLiteral).value;
    } else if (node.type === 'Identifier') {
      // Find variable declaration
      let value: string | null = null;
      const targetName = (node as Identifier).name;
      traverse(ast, {
        VariableDeclarator: (path: NodePath<VariableDeclarator>) => {
          if (path.node.id.type === 'Identifier' &&
              path.node.id.name === targetName &&
              path.node.init &&
              path.node.init.type === 'StringLiteral') {
            value = (path.node.init as StringLiteral).value;
          }
        }
      });
      return value;
    } else if (node.type === 'BinaryExpression') {
      const binaryNode = node as BinaryExpression;
      const left = this.resolveExpression(binaryNode.left, ast);
      const right = this.resolveExpression(binaryNode.right, ast);
      if (left && right && binaryNode.operator === '+') {
        return left + right;
      }
    } else if (node.type === 'MemberExpression') {
      // Resolve MemberExpression (for TemplateLiteral with objects)
      return this.resolveMemberExpression(node as MemberExpression, ast);
    }
    return null;
  }

  /**
   * Resolve ${template} - TemplateLiteral with variables
   */
  evaluateTemplate(line: number, ast: ParseResult<File>): string | null {
    let templateLiteral: TemplateLiteral | null = null;

    // Find app.use() and TemplateLiteral
    traverse(ast, {
      CallExpression: (path: NodePath<CallExpression>) => {
        const node = path.node;
        if (node.loc?.start.line === line) {
          if (node.callee.type === 'MemberExpression' &&
              (node.callee.property as Identifier).name === 'use' &&
              node.arguments.length >= 2) {
            const firstArg = node.arguments[0];
            if (firstArg.type === 'TemplateLiteral') {
              templateLiteral = firstArg;
            }
          }
        }
      }
    });

    if (!templateLiteral) {
      return null;
    }

    // Cast to help TypeScript understand the narrowing after closure mutation
    const tmpl = templateLiteral as TemplateLiteral;

    // Assemble string from quasis and expressions
    let result = '';
    for (let i = 0; i < tmpl.quasis.length; i++) {
      result += tmpl.quasis[i].value.raw;

      if (i < tmpl.expressions.length) {
        const expr = tmpl.expressions[i];
        const resolvedValue = this.resolveExpression(expr as Node, ast);
        if (resolvedValue === null) {
          return null; // Couldn't resolve expression
        }
        result += resolvedValue;
      }
    }

    return result;
  }

  /**
   * Resolve ${member} - MemberExpression (config.apiPrefix)
   */
  evaluateMember(line: number, ast: ParseResult<File>): string | null {
    let memberExpression: MemberExpression | null = null;

    // Find app.use() and MemberExpression
    traverse(ast, {
      CallExpression: (path: NodePath<CallExpression>) => {
        const node = path.node;
        if (node.loc?.start.line === line) {
          if (node.callee.type === 'MemberExpression' &&
              (node.callee.property as Identifier).name === 'use' &&
              node.arguments.length >= 2) {
            const firstArg = node.arguments[0];
            if (firstArg.type === 'MemberExpression') {
              memberExpression = firstArg;
            }
          }
        }
      }
    });

    if (!memberExpression) {
      return null;
    }

    // Resolve MemberExpression (can be nested: config.nested.path)
    return this.resolveMemberExpression(memberExpression, ast);
  }

  /**
   * Recursively resolve MemberExpression
   */
  resolveMemberExpression(node: MemberExpression, ast: ParseResult<File>): string | null {
    if (node.type !== 'MemberExpression') {
      return null;
    }

    // Get path to property: config.nested.path → ['config', 'nested', 'path']
    const path: (string | number)[] = [];
    let current: Node = node;
    while (current.type === 'MemberExpression') {
      const memberNode = current as MemberExpression;
      if (memberNode.property.type === 'Identifier') {
        path.unshift((memberNode.property as Identifier).name);
      } else if (memberNode.property.type === 'NumericLiteral') {
        // Array access: arr[0]
        path.unshift((memberNode.property as NumericLiteral).value);
      }
      current = memberNode.object;
    }

    if (current.type === 'Identifier') {
      path.unshift((current as Identifier).name);
    } else {
      return null;
    }

    // Now resolve via AST
    // Find object declaration
    const rootName = path[0] as string;
    let objectValue: Record<string, unknown> | unknown[] | null = null;

    traverse(ast, {
      VariableDeclarator: (varPath: NodePath<VariableDeclarator>) => {
        if (varPath.node.id.type === 'Identifier' &&
            varPath.node.id.name === rootName &&
            varPath.node.init &&
            varPath.node.init.type === 'ObjectExpression') {
          objectValue = this.evaluateObjectExpression(varPath.node.init as ObjectExpression);
        } else if (varPath.node.id.type === 'Identifier' &&
                   varPath.node.id.name === rootName &&
                   varPath.node.init &&
                   varPath.node.init.type === 'ArrayExpression') {
          objectValue = this.evaluateArrayExpression(varPath.node.init as ArrayExpression);
        }
      }
    });

    if (!objectValue) {
      return null;
    }

    // Walk through path and get value
    let result: unknown = objectValue;
    for (let i = 1; i < path.length; i++) {
      const key = path[i];
      if (result && typeof result === 'object' && key in (result as Record<string, unknown>)) {
        result = (result as Record<string | number, unknown>)[key];
      } else {
        return null;
      }
    }

    return typeof result === 'string' ? result : null;
  }

  /**
   * Evaluate ObjectExpression to plain JS object
   */
  evaluateObjectExpression(node: ObjectExpression): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (prop.type === 'ObjectProperty') {
        const objProp = prop as ObjectProperty;
        if (objProp.key.type === 'Identifier') {
          const key = (objProp.key as Identifier).name;
          if (objProp.value.type === 'StringLiteral') {
            obj[key] = (objProp.value as StringLiteral).value;
          } else if (objProp.value.type === 'ObjectExpression') {
            obj[key] = this.evaluateObjectExpression(objProp.value);
          }
        }
      }
    }
    return obj;
  }

  /**
   * Evaluate ArrayExpression to plain JS array
   */
  evaluateArrayExpression(node: ArrayExpression): string[] {
    const arr: string[] = [];
    for (const element of node.elements) {
      if (element && element.type === 'StringLiteral') {
        arr.push((element as StringLiteral).value);
      }
    }
    return arr;
  }

  /**
   * Helper method for finding edges
   */
  findEdges(graph: Graph, criteria: EdgeCriteria): Edge[] {
    const result: Edge[] = [];
    if (!graph.edges) return result;

    for (const edge of graph.edges.values()) {
      let matches = true;
      for (const [key, value] of Object.entries(criteria)) {
        if (edge[key] !== value) {
          matches = false;
          break;
        }
      }
      if (matches) {
        result.push(edge);
      }
    }
    return result;
  }
}
