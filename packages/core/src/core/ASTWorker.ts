/**
 * ASTWorker - worker thread script for parallel AST parsing
 *
 * Receives: { filePath, moduleId, moduleName }
 * Returns: { collections } - extracted AST data for GraphBuilder
 *
 * Uses ScopeTracker for semantic ID generation (REG-133).
 * IDs are stable and don't change when unrelated code is added/removed.
 */

import { parentPort } from 'worker_threads';
import { readFileSync } from 'fs';
import { basename } from 'path';
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { Node, ImportDeclaration, ExportNamedDeclaration, ExportDefaultDeclaration, VariableDeclaration, FunctionDeclaration, ClassDeclaration, CallExpression, Identifier, ExportSpecifier } from '@babel/types';
import type { NodePath, Visitor } from '@babel/traverse';
import { ClassNode, type ClassNodeRecord } from './nodes/ClassNode.js';
import { ImportNode, type ImportNodeRecord } from './nodes/ImportNode.js';
import { ExportNode, type ExportNodeRecord } from './nodes/ExportNode.js';
import { ScopeTracker } from './ScopeTracker.js';
import { computeSemanticId } from './SemanticId.js';
import { getLine, getColumn } from '../plugins/analysis/ast/utils/location.js';
import { getTraverseFunction } from '../plugins/analysis/ast/utils/babelTraverse.js';

const traverse = getTraverseFunction(traverseModule);

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
  imports: ImportNodeRecord[];
  exports: ExportNodeRecord[];
  httpRequests: unknown[];
  literals: unknown[];
  variableAssignments: unknown[];
}

/**
 * Counters for unique IDs
 * @deprecated Use ScopeTracker.getItemCounter() instead
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
 *
 * Uses ScopeTracker for semantic ID generation - IDs are stable
 * and don't change when unrelated code is added/removed.
 */
function parseModule(filePath: string, moduleId: string, moduleName: string): ASTCollections {
  const code = readFileSync(filePath, 'utf-8');

  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'] as ParserPlugin[]
  });

  // Create ScopeTracker for semantic ID generation
  // Use basename for shorter, more readable IDs
  const scopeTracker = new ScopeTracker(basename(filePath));

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

  // Processed nodes tracking (still needed for deduplication)
  const processed: ProcessedNodes = {
    callSites: new Set(),
    methodCalls: new Set(),
    varDecls: new Set(),
    eventListeners: new Set()
  };

  const _module: ModuleInfo = { id: moduleId, file: filePath, name: moduleName };

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

        // Babel AST guarantees node.loc exists with locations: true option
        const importNode = ImportNode.create(
          localName,      // name
          filePath,       // file
          getLine(node),  // line (non-null - Babel guarantees location)
          0,              // column (not available in this worker)
          source,         // source
          { imported: importedName, local: localName }
        );
        collections.imports.push(importNode);
      });
    }
  });

  // Extract exports using semantic IDs (via createWithContext)
  traverse(ast, {
    ExportNamedDeclaration(path: NodePath<ExportNamedDeclaration>) {
      const node = path.node;

      if (node.declaration) {
        if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
          const exportNode = ExportNode.createWithContext(
            node.declaration.id.name,
            scopeTracker.getContext(),
            { line: getLine(node), column: 0 },
            { exportType: 'named' }
          );
          collections.exports.push(exportNode);
        } else if (node.declaration.type === 'ClassDeclaration' && node.declaration.id) {
          const exportNode = ExportNode.createWithContext(
            node.declaration.id.name,
            scopeTracker.getContext(),
            { line: getLine(node), column: 0 },
            { exportType: 'named' }
          );
          collections.exports.push(exportNode);
        } else if (node.declaration.type === 'VariableDeclaration') {
          node.declaration.declarations.forEach(decl => {
            if (decl.id.type === 'Identifier') {
              const exportNode = ExportNode.createWithContext(
                decl.id.name,
                scopeTracker.getContext(),
                { line: getLine(node), column: 0 },
                { exportType: 'named' }
              );
              collections.exports.push(exportNode);
            }
          });
        }
      }

      if (node.specifiers) {
        node.specifiers.forEach(spec => {
          if (spec.type !== 'ExportSpecifier') return;
          const exportedName = spec.exported.type === 'Identifier' ? spec.exported.name : spec.exported.value;
          const exportNode = ExportNode.createWithContext(
            exportedName,
            scopeTracker.getContext(),
            { line: getLine(node), column: 0 },
            {
              local: (spec as ExportSpecifier).local.name,
              exportType: 'named'
            }
          );
          collections.exports.push(exportNode);
        });
      }
    },

    ExportDefaultDeclaration(path: NodePath<ExportDefaultDeclaration>) {
      const node = path.node;
      let localName = 'default';

      if (node.declaration.type === 'Identifier') {
        localName = node.declaration.name;
      } else if ('id' in node.declaration && node.declaration.id) {
        localName = (node.declaration.id as Identifier).name;
      }

      const exportNode = ExportNode.createWithContext(
        'default',
        scopeTracker.getContext(),
        { line: getLine(node), column: 0 },
        {
          local: localName,
          default: true,
          exportType: 'default'
        }
      );
      collections.exports.push(exportNode);
    }
  });

  // Extract top-level variables using semantic IDs
  traverse(ast, {
    VariableDeclaration(path: NodePath<VariableDeclaration>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      const isConst = node.kind === 'const';

      node.declarations.forEach(decl => {
        if (decl.id.type === 'Identifier') {
          const varName = decl.id.name;
          const line = getLine(decl.id);

          const literalValue = ExpressionEvaluator.extractLiteralValue(decl.init);
          const isLiteral = literalValue !== null;
          const isNewExpr = decl.init?.type === 'NewExpression';
          const shouldBeConstant = isConst && (isLiteral || isNewExpr);

          // Generate semantic ID using ScopeTracker
          const nodeType = shouldBeConstant ? 'CONSTANT' : 'VARIABLE';
          const varId = computeSemanticId(nodeType, varName, scopeTracker.getContext());

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

  // Extract functions and classes using semantic IDs
  traverse(ast, {
    FunctionDeclaration(path: NodePath<FunctionDeclaration>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      if (!node.id) return;

      const funcName = node.id.name;
      // Generate semantic ID using ScopeTracker
      const functionId = computeSemanticId('FUNCTION', funcName, scopeTracker.getContext());

      collections.functions.push({
        id: functionId,
        type: 'FUNCTION',
        name: funcName,
        file: filePath,
        line: getLine(node),
        column: getColumn(node),
        async: node.async || false,
        generator: node.generator || false,
        exported: path.parent?.type === 'ExportNamedDeclaration' || path.parent?.type === 'ExportDefaultDeclaration'
      });

      // Enter function scope for parameter extraction
      scopeTracker.enterScope(funcName, 'FUNCTION');

      // Extract parameters with semantic IDs
      node.params.forEach((param, index) => {
        if (param.type === 'Identifier') {
          const paramId = computeSemanticId('PARAMETER', param.name, scopeTracker.getContext(), { discriminator: index });
          collections.parameters.push({
            id: paramId,
            type: 'PARAMETER',
            name: param.name,
            index,
            functionId,
            file: filePath,
            line: getLine(param)
          });
        }
      });

      // Exit function scope
      scopeTracker.exitScope();
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

      // Create CLASS node using ClassNode.createWithContext() for semantic IDs
      const classRecord = ClassNode.createWithContext(
        className,
        scopeTracker.getContext(),
        { line: getLine(node), column: getColumn(node) },
        { superClass: superClassName || undefined }
      );

      collections.classDeclarations.push(classRecord);

      // Enter class scope for method extraction
      scopeTracker.enterScope(className, 'CLASS');

      // Extract methods with semantic IDs (including class scope)
      node.body.body.forEach(member => {
        if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
          const methodName = member.key.name;
          // Method ID includes class scope: file->ClassName->FUNCTION->methodName
          const methodId = computeSemanticId('FUNCTION', methodName, scopeTracker.getContext());

          collections.functions.push({
            id: methodId,
            type: 'METHOD',
            name: methodName,
            className,
            classId: classRecord.id,
            file: filePath,
            line: getLine(member),
            column: getColumn(member),
            async: member.async || false,
            isClassMethod: true,
            isConstructor: member.kind === 'constructor',
            isStatic: member.static || false
          });
        }
      });

      // Exit class scope
      scopeTracker.exitScope();
    }
  });

  // Extract call expressions at module level using semantic IDs with discriminators
  traverse(ast, {
    CallExpression(path: NodePath<CallExpression>) {
      if (path.getFunctionParent()) return;

      const node = path.node;
      const nodeKey = `${node.start}:${node.end}`;

      if (node.callee.type === 'Identifier') {
        if (processed.callSites.has(nodeKey)) return;
        processed.callSites.add(nodeKey);

        // Get discriminator for same-named calls in current scope
        const calleeName = node.callee.name;
        const discriminator = scopeTracker.getItemCounter(`CALL:${calleeName}`);
        const callId = computeSemanticId('CALL', calleeName, scopeTracker.getContext(), { discriminator });

        collections.callSites.push({
          id: callId,
          type: 'CALL',
          name: calleeName,
          file: filePath,
          line: getLine(node),
          parentScopeId: moduleId,
          targetFunctionName: calleeName
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

          // Get discriminator for same-named method calls
          const discriminator = scopeTracker.getItemCounter(`CALL:${fullName}`);
          const callId = computeSemanticId('CALL', fullName, scopeTracker.getContext(), { discriminator });

          collections.methodCalls.push({
            id: callId,
            type: 'CALL',
            name: fullName,
            object: objectName,
            method: methodName,
            file: filePath,
            line: getLine(node),
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
        const message = error instanceof Error ? error.message : String(error);
        parentPort!.postMessage({ type: 'error', taskId: msg.taskId, error: message });
      }
    } else if (msg.type === 'exit') {
      process.exit(0);
    }
  });

  // Signal ready
  parentPort.postMessage({ type: 'ready' });
}
