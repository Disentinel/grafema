/**
 * JSX and component analysis for React.
 *
 * Detects React component definitions, JSX rendering relationships,
 * event handlers, prop passing, forwardRef, and createContext usage.
 *
 * @module react-internal/jsx
 */
import type { NodePath } from '@babel/traverse';
import type { Node, CallExpression, JSXElement, JSXAttribute } from '@babel/types';
import { getLine, getColumn } from '../ast/utils/location.js';
import { getMemberExpressionName } from '../ast/utils/getMemberExpressionName.js';
import { getExpressionValue } from '../ast/utils/getExpressionValue.js';
import { REACT_EVENTS } from './types.js';
import type { EventNode, AnalysisResult } from './types.js';

/**
 * Check if a function path is a React component (returns JSX).
 *
 * A React component must:
 * 1. Be a function (arrow, expression, or declaration)
 * 2. Have a name starting with uppercase
 * 3. Contain JSX in its body
 */
export function isReactComponent(path: NodePath): boolean {
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
 * Analyze a JSX element for component rendering relationships.
 *
 * For custom components (uppercase names), creates RENDERS edges
 * from the parent component to the rendered child component.
 */
export function analyzeJSXElement(
  path: NodePath<JSXElement>,
  filePath: string,
  analysis: AnalysisResult
): void {
  const openingElement = path.node.openingElement;
  const elementName = getJSXElementName(openingElement.name);

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
      const funcName = getFunctionName(parentPath);
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

/**
 * Analyze a JSX attribute for event handlers and prop passing.
 *
 * Creates dom:event nodes for React event handler props (onClick, etc.)
 * and PASSES_PROP edges for props passed to child components.
 */
export function analyzeJSXAttribute(
  path: NodePath<JSXAttribute>,
  filePath: string,
  analysis: AnalysisResult
): void {
  const attr = path.node;
  if (!attr.name || attr.name.type !== 'JSXIdentifier') return;

  const attrName = attr.name.name;

  // Get parent JSX element info first
  const jsxOpeningElement = path.parent as { type: string; name?: Node };
  let componentName: string | null = null;
  let isComponent = false;

  if (jsxOpeningElement?.type === 'JSXOpeningElement' && jsxOpeningElement.name) {
    componentName = getJSXElementName(jsxOpeningElement.name);
    isComponent = /^[A-Z]/.test(componentName);
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
        handlerName = getMemberExpressionName(expr);
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
  if (isComponent && componentName && attrName !== 'key' && attrName !== 'ref' && attrName !== 'children') {
    let propValue = '<expression>';
    const value = attr.value as { type: string; value?: string; expression?: Node } | null;
    if (value?.type === 'StringLiteral') {
      propValue = value.value || '';
    } else if (value?.type === 'JSXExpressionContainer') {
      propValue = getExpressionValue(value.expression!);
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
        const funcName = getFunctionName(parentPath);
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
 * Analyze forwardRef usage to register a component.
 */
export function analyzeForwardRef(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult
): void {
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
 * Analyze createContext usage to register a context provider.
 */
export function analyzeCreateContext(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult
): void {
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
      defaultValue: getExpressionValue(defaultValue as Node)
    });
  }
}

// --- Module-internal helpers ---

function getJSXElementName(nameNode: Node): string {
  if (nameNode.type === 'JSXIdentifier') {
    return (nameNode as { name: string }).name;
  }
  if (nameNode.type === 'JSXMemberExpression') {
    const memExpr = nameNode as { object: Node; property: { name: string } };
    return `${getJSXElementName(memExpr.object)}.${memExpr.property.name}`;
  }
  return '<unknown>';
}

function getFunctionName(path: NodePath): string | null {
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
