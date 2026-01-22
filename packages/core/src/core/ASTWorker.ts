/**
 * ASTWorker - worker thread script for parallel AST parsing
 *
 * Receives: { filePath, moduleId, moduleName }
 * Returns: { collections } - extracted AST data for GraphBuilder
 */

import { parentPort } from 'worker_threads';
import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { Node, ImportDeclaration, ExportNamedDeclaration, ExportDefaultDeclaration, VariableDeclaration, FunctionDeclaration, ClassDeclaration, CallExpression, Identifier, ExportSpecifier } from '@babel/types';
import type { NodePath, Visitor } from '@babel/traverse';
import { ClassNode, type ClassNodeRecord } from './nodes/ClassNode.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

// Simplified visitors for extraction (no graph access needed)
import { ExpressionEvaluator } from '../plugins/analysis/ast/ExpressionEvaluator.js';

/**
 * Message types from main thread
 */
interface ParseMessage {
  type: 'parse';
  taskId: number;
  filePath: string;
  moduleId: string;
  moduleName: string;
}

interface ExitMessage {
  type: 'exit';
}

type WorkerMessage = ParseMessage | ExitMessage;

/**
 * Import node structure
 */
interface ImportNode {
  id: string;
  type: 'IMPORT';
  name: string;
  importedName: string;
  source: string;
  file: string;
  line: number;
}

/**
 * Export node structure
 */
interface ExportNode {
  id: string;
  type: 'EXPORT';
  name: string;
  exportType?: string;
  localName?: string;
  isDefault?: boolean;
  file: string;
  line: number;
}

/**
 * Variable declaration node
 */
interface VariableDeclarationNode {
  id: string;
  type: 'CONSTANT' | 'VARIABLE';
  name: string;
  file: string;
  line: number;
  value?: unknown;
  parentScopeId: string;
}

/**
 * Class instantiation info
 */
interface ClassInstantiationInfo {
  variableId: string;
  variableName: string;
  className: string;
  line: number;
  parentScopeId: string;
}

/**
 * Function node structure
 */
interface FunctionNode {
  id: string;
  stableId: string;
  type: 'FUNCTION' | 'METHOD';
  name: string;
  file: string;
  line: number;
  column: number;
  async: boolean;
  generator?: boolean;
  exported?: boolean;
  className?: string;
  classId?: string;
  isClassMethod?: boolean;
  isConstructor?: boolean;
  isStatic?: boolean;
}

/**
 * Parameter node structure
 */
interface ParameterNode {
  id: string;
  type: 'PARAMETER';
  name: string;
  index: number;
  functionId: string;
  file: string;
  line: number;
}

/**
 * Class declaration node (matches ClassNodeRecord from ClassNode factory)
 * Workers use legacy line-based IDs
 */
interface ClassDeclarationNode extends ClassNodeRecord {
  // All fields inherited from ClassNodeRecord
}

/**
 * Call site node
 */
interface CallSiteNode {
  id: string;
  type: 'CALL';
  name: string;
  file: string;
  line: number;
  parentScopeId: string;
  targetFunctionName?: string;
  object?: string;
  method?: string;
}

/**
 * Collections extracted from AST
 */
export interface ASTCollections {
  functions: FunctionNode[];
  parameters: ParameterNode[];
  scopes: unknown[];
  variableDeclarations: VariableDeclarationNode[];
  callSites: CallSiteNode[];
  methodCalls: CallSiteNode[];
  eventListeners: unknown[];
  classInstantiations: ClassInstantiationInfo[];
  classDeclarations: ClassDeclarationNode[];
  methodCallbacks: unknown[];
  callArguments: unknown[];
  imports: ImportNode[];
  exports: ExportNode[];
  httpRequests: unknown[];
  literals: unknown[];
  variableAssignments: unknown[];
}

/**
 * Counters for unique IDs
 */
interface Counters {
  ifScope: number;
  scope: number;
  varDecl: number;
  callSite: number;
  function: number;
  httpRequest: number;
  literal: number;
}

/**
 * Processed nodes tracking
 */
interface ProcessedNodes {
  callSites: Set<string>;
  methodCalls: Set<string>;
  varDecls: Set<string>;
  eventListeners: Set<string>;
}

/**
 * Module info
 */
interface ModuleInfo {
  id: string;
  file: string;
  name: string;
}

/**
 * Parse a single module and extract all collections
 */
function parseModule(filePath: string, moduleId: string, moduleName: string): ASTCollections {
  const code = readFileSync(filePath, 'utf-8');

  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'] as ParserPlugin[]
  });

  // Collections to extract
  const collections: ASTCollections = {
    functions: [],
    parameters: [],
    scopes: [],
    variableDeclarations: [],
    callSites: [],
    methodCalls: [],
    eventListeners: [],
    classInstantiations: [],
    classDeclarations: [],
    methodCallbacks: [],
    callArguments: [],
    imports: [],
    exports: [],
    httpRequests: [],
    literals: [],
    variableAssignments: []
  };

  // Counters for unique IDs
  const counters: Counters = {
    ifScope: 0,
    scope: 0,
    varDecl: 0,
    callSite: 0,
    function: 0,
    httpRequest: 0,
    literal: 0
  };

  // Processed nodes tracking
  const processed: ProcessedNodes = {
    callSites: new Set(),
    methodCalls: new Set(),
    varDecls: new Set(),
    eventListeners: new Set()
  };

  const module: ModuleInfo = { id: moduleId, file: filePath, name: moduleName };

  // Extract imports
  traverse(ast, {
    ImportDeclaration(path: NodePath<ImportDeclaration>) {
      const node = path.node;
      const source = node.source.value;

      node.specifiers.forEach(spec => {
        let importedName: string;
        let localName: string;

        if (spec.type === 'ImportDefaultSpecifier') {
          importedName = 'default';
          localName = spec.local.name;
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          importedName = '*';
          localName = spec.local.name;
        } else {
          importedName = (spec.imported as Identifier)?.name || spec.local.name;
          localName = spec.local.name;
        }

        collections.imports.push({
          id: `IMPORT#${localName}#${filePath}#${node.loc!.start.line}`,
          type: 'IMPORT',
          name: localName,
          importedName,
          source,
          file: filePath,
          line: node.loc!.start.line
        });
      });
    }
  });

  // Extract exports
  traverse(ast, {
    ExportNamedDeclaration(path: NodePath<ExportNamedDeclaration>) {
      const node = path.node;

      if (node.declaration) {
        if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
          collections.exports.push({
            id: `EXPORT#${node.declaration.id.name}#${filePath}#${node.loc!.start.line}`,
            type: 'EXPORT',
            name: node.declaration.id.name,
            exportType: 'function',
            file: filePath,
            line: node.loc!.start.line
          });
        } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
          collections.exports.push({
            id: `EXPORT#${node.declaration.id.name}#${filePath}#${node.loc!.start.line}`,
            type: 'EXPORT',
            name: node.declaration.id.name,
            exportType: 'class',
            file: filePath,
            line: node.loc!.start.line
          });
        } else if (node.declaration.type === 'VariableDeclaration') {
          node.declaration.declarations.forEach(decl => {
            if (decl.id.type === 'Identifier') {
              collections.exports.push({
                id: `EXPORT#${decl.id.name}#${filePath}#${node.loc!.start.line}`,
                type: 'EXPORT',
                name: decl.id.name,
                exportType: 'variable',
                file: filePath,
                line: node.loc!.start.line
              });
            }
          });
        }
      }

      if (node.specifiers) {
        node.specifiers.forEach(spec => {
          if (spec.type !== 'ExportSpecifier') return;
          const exportedName = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
          collections.exports.push({
            id: `EXPORT#${exportedName}#${filePath}#${node.loc!.start.line}`,
            type: 'EXPORT',
            name: exportedName,
            localName: (spec as ExportSpecifier).local.name,
            file: filePath,
            line: node.loc!.start.line
          });
        });
      }
    },

    ExportDefaultDeclaration(path: NodePath<ExportDefaultDeclaration>) {
      const node = path.node;
      let name = 'default';

      if (node.declaration.type === 'Identifier') {
        name = node.declaration.name;
      } else if ('id' in node.declaration && node.declaration.id) {
        name = (node.declaration.id as Identifier).name;
      }

      collections.exports.push({
        id: `EXPORT#default#${filePath}#${node.loc!.start.line}`,
        type: 'EXPORT',
        name: 'default',
        localName: name,
        isDefault: true,
        file: filePath,
        line: node.loc!.start.line
      });
    }
  });

  // Extract top-level variables
  traverse(ast, {
    VariableDeclaration(path: NodePath<VariableDeclaration>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      const isConst = node.kind === 'const';

      node.declarations.forEach(decl => {
        if (decl.id.type === 'Identifier') {
          const varName = decl.id.name;
          const line = decl.id.loc!.start.line;
          const column = decl.id.loc!.start.column;

          const literalValue = ExpressionEvaluator.extractLiteralValue(decl.init);
          const isLiteral = literalValue !== null;
          const isNewExpr = decl.init?.type === 'NewExpression';
          const shouldBeConstant = isConst && (isLiteral || isNewExpr);

          const varId = shouldBeConstant
            ? `CONSTANT#${varName}#${filePath}#${line}:${column}:${counters.varDecl++}`
            : `VARIABLE#${varName}#${filePath}#${line}:${column}:${counters.varDecl++}`;

          collections.variableDeclarations.push({
            id: varId,
            type: shouldBeConstant ? 'CONSTANT' : 'VARIABLE',
            name: varName,
            file: filePath,
            line,
            value: isLiteral ? literalValue : undefined,
            parentScopeId: moduleId
          });

          if (isNewExpr && decl.init!.type === 'NewExpression' && (decl.init! as { callee: Node }).callee.type === 'Identifier') {
            collections.classInstantiations.push({
              variableId: varId,
              variableName: varName,
              className: ((decl.init! as { callee: Identifier }).callee).name,
              line,
              parentScopeId: moduleId
            });
          }
        }
      });
    }
  });

  // Extract functions and classes
  traverse(ast, {
    FunctionDeclaration(path: NodePath<FunctionDeclaration>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      if (!node.id) return;

      const funcName = node.id.name;
      const functionId = `FUNCTION#${funcName}#${filePath}#${node.loc!.start.line}:${node.loc!.start.column}`;

      collections.functions.push({
        id: functionId,
        stableId: functionId,
        type: 'FUNCTION',
        name: funcName,
        file: filePath,
        line: node.loc!.start.line,
        column: node.loc!.start.column,
        async: node.async || false,
        generator: node.generator || false,
        exported: path.parent?.type === 'ExportNamedDeclaration' || path.parent?.type === 'ExportDefaultDeclaration'
      });

      // Extract parameters
      node.params.forEach((param, index) => {
        if (param.type === 'Identifier') {
          collections.parameters.push({
            id: `PARAMETER#${param.name}#${functionId}#${index}`,
            type: 'PARAMETER',
            name: param.name,
            index,
            functionId,
            file: filePath,
            line: param.loc!.start.line
          });
        }
      });
    },

    ClassDeclaration(path: NodePath<ClassDeclaration>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      if (!node.id) return;

      const className = node.id.name;

      // Extract superClass name
      const superClassName = node.superClass && node.superClass.type === 'Identifier'
        ? (node.superClass as Identifier).name
        : null;

      // Create CLASS node using ClassNode.create() (legacy format for workers)
      const classRecord = ClassNode.create(
        className,
        filePath,
        node.loc!.start.line,
        node.loc!.start.column || 0,
        { superClass: superClassName || undefined }
      );

      collections.classDeclarations.push(classRecord);

      // Extract methods
      node.body.body.forEach(member => {
        if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
          const methodName = member.key.name;
          const methodId = `METHOD#${className}.${methodName}#${filePath}#${member.loc!.start.line}`;

          collections.functions.push({
            id: methodId,
            stableId: methodId,
            type: 'METHOD',
            name: methodName,
            className,
            classId: classRecord.id,
            file: filePath,
            line: member.loc!.start.line,
            column: member.loc!.start.column,
            async: member.async || false,
            isClassMethod: true,
            isConstructor: member.kind === 'constructor',
            isStatic: member.static || false
          });
        }
      });
    }
  });

  // Extract call expressions at module level
  traverse(ast, {
    CallExpression(path: NodePath<CallExpression>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      const nodeKey = `${node.start}:${node.end}`;

      if (node.callee.type === 'Identifier') {
        if (processed.callSites.has(nodeKey)) return;
        processed.callSites.add(nodeKey);

        collections.callSites.push({
          id: `CALL#${node.callee.name}#${filePath}#${node.loc!.start.line}:${node.loc!.start.column}:${counters.callSite++}`,
          type: 'CALL',
          name: node.callee.name,
          file: filePath,
          line: node.loc!.start.line,
          parentScopeId: moduleId,
          targetFunctionName: node.callee.name
        });
      } else if (node.callee.type === 'MemberExpression') {
        const obj = node.callee.object;
        const prop = node.callee.property;

        if ((obj.type === 'Identifier' || obj.type === 'ThisExpression') && prop.type === 'Identifier') {
          if (processed.methodCalls.has(nodeKey)) return;
          processed.methodCalls.add(nodeKey);

          const objectName = obj.type === 'Identifier' ? obj.name : 'this';
          const methodName = prop.name;
          const fullName = `${objectName}.${methodName}`;

          collections.methodCalls.push({
            id: `CALL#${fullName}#${filePath}#${node.loc!.start.line}:${node.loc!.start.column}:${counters.callSite++}`,
            type: 'CALL',
            name: fullName,
            object: objectName,
            method: methodName,
            file: filePath,
            line: node.loc!.start.line,
            parentScopeId: moduleId
          });
        }
      }
    }
  });

  return collections;
}

// Listen for messages from main thread
if (parentPort) {
  parentPort.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'parse') {
      try {
        const collections = parseModule(msg.filePath, msg.moduleId, msg.moduleName);
        parentPort!.postMessage({ type: 'result', taskId: msg.taskId, collections });
      } catch (error) {
        parentPort!.postMessage({ type: 'error', taskId: msg.taskId, error: (error as Error).message });
      }
    } else if (msg.type === 'exit') {
      process.exit(0);
    }
  });

  // Signal ready
  parentPort.postMessage({ type: 'ready' });
}
