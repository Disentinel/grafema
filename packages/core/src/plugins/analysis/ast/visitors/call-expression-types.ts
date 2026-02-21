/**
 * Type definitions for CallExpressionVisitor and related extractors.
 *
 * Extracted from CallExpressionVisitor.ts (REG-424) to reduce file size.
 */

import type { Node } from '@babel/types';
import type { GrafemaIgnoreAnnotation } from '../types.js';

/**
 * Object literal info for OBJECT_LITERAL nodes
 */
export interface ObjectLiteralInfo {
  id: string;
  type: 'OBJECT_LITERAL';
  file: string;
  line: number;
  column: number;
  parentCallId?: string;
  argIndex?: number;
  isSpread?: boolean;
}

/**
 * Object property info for HAS_PROPERTY edges
 */
export interface ObjectPropertyInfo {
  objectId: string;
  propertyName: string;
  valueNodeId?: string;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;
  literalValue?: unknown;
  file: string;
  line: number;
  column: number;
  callLine?: number;
  callColumn?: number;
  nestedObjectId?: string;
  nestedArrayId?: string;
  // REG-329: Scope path for variable resolution
  valueScopePath?: string[];
}

/**
 * Array literal info for ARRAY_LITERAL nodes
 */
export interface ArrayLiteralInfo {
  id: string;
  type: 'ARRAY_LITERAL';
  file: string;
  line: number;
  column: number;
  parentCallId?: string;
  argIndex?: number;
}

/**
 * Array element info for HAS_ELEMENT edges
 */
export interface ArrayElementInfo {
  arrayId: string;
  index: number;
  valueNodeId?: string;
  valueType: 'LITERAL' | 'VARIABLE' | 'CALL' | 'EXPRESSION' | 'OBJECT_LITERAL' | 'ARRAY_LITERAL' | 'SPREAD';
  valueName?: string;
  literalValue?: unknown;
  file: string;
  line: number;
  column: number;
  callLine?: number;
  callColumn?: number;
  nestedObjectId?: string;
  nestedArrayId?: string;
}

/**
 * Argument info for PASSES_ARGUMENT edges
 */
export interface ArgumentInfo {
  callId: string;
  argIndex: number;
  file: string;
  line: number;
  column: number;
  isSpread?: boolean;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  literalValue?: unknown;
  functionLine?: number;
  functionColumn?: number;
  nestedCallLine?: number;
  nestedCallColumn?: number;
  objectName?: string;
  propertyName?: string;
  expressionType?: string;
}

/**
 * Call site info
 */
export interface CallSiteInfo {
  id: string;
  type: 'CALL';
  name: string;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId: string;
  targetFunctionName: string;
  isNew?: boolean;
  /** REG-297: true if wrapped in await expression */
  isAwaited?: boolean;
}

/**
 * Method call info
 */
export interface MethodCallInfo {
  id: string;
  type: 'CALL';
  name: string;
  object: string;
  method: string;
  computed?: boolean;
  computedPropertyVar?: string | null;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  parentScopeId: string;
  isNew?: boolean;
  /** REG-332: Annotation to suppress strict mode errors */
  grafemaIgnore?: GrafemaIgnoreAnnotation;
  /** REG-297: true if wrapped in await expression */
  isAwaited?: boolean;
}

/**
 * Event listener info
 */
export interface EventListenerInfo {
  id: string;
  type: 'event:listener';
  name: string;
  object: string;
  file: string;
  line: number;
  parentScopeId: string;
  callbackArg: Node;
}

/**
 * Method callback info
 */
export interface MethodCallbackInfo {
  methodCallId: string;
  callbackLine: number;
  callbackColumn: number;
  callbackType: string;
}

/**
 * Literal node info
 */
export interface LiteralInfo {
  id: string;
  type: 'LITERAL' | 'EXPRESSION';
  value?: unknown;
  valueType?: string;
  expressionType?: string;
  operator?: string;
  name?: string;
  file: string;
  line: number;
  column: number;
  parentCallId: string;
  argIndex: number;
}
