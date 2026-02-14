/**
 * extractNamesFromPattern - Extract variable names from destructuring patterns
 *
 * Shared utility for extracting variable bindings from ObjectPattern, ArrayPattern,
 * and nested destructuring patterns. Used by both VariableVisitor (for variable
 * declarations) and createParameterNodes (for function parameters).
 *
 * Handles:
 * - Object destructuring: { x, y }
 * - Nested object destructuring: { data: { user } }
 * - Property renaming: { old: newName }
 * - Array destructuring: [first, second]
 * - Sparse array destructuring: [, , third]
 * - Rest elements: { a, ...rest } or [first, ...rest]
 * - Default values: { x = 42 } or [x = 10]
 * - Mixed patterns: { items: [first, second] }
 *
 * REG-201: Original implementation for variable destructuring
 * REG-399: Extended for parameter destructuring support
 */

import * as t from '@babel/types';

/**
 * Information about an extracted variable from a destructuring pattern.
 * Used for both VARIABLE nodes (declarations) and PARAMETER nodes (function params).
 */
export interface ExtractedVariable {
  /** Variable name (the binding identifier) */
  name: string;
  /** Source location for the binding */
  loc: { start: { line: number; column: number } };
  /** Property path for nested object destructuring (e.g., ['data', 'user'] for { data: { user } }) */
  propertyPath?: string[];
  /** Array index for array destructuring (e.g., 0 for first element in [first, second]) */
  arrayIndex?: number;
  /** True for rest elements ({ a, ...rest } or [first, ...rest]) */
  isRest?: boolean;
  /** True if this binding has a default value (tracked during AssignmentPattern recursion) */
  hasDefault?: boolean;
}

/**
 * Extract all variable names from a destructuring pattern.
 *
 * Pure function - no side effects, no instance state dependencies.
 * Recursively processes nested patterns and accumulates bindings.
 *
 * @param pattern - AST node (ObjectPattern, ArrayPattern, Identifier, etc.)
 * @param variables - Accumulator for extracted variables (internal)
 * @param propertyPath - Current property path for nested destructuring (internal)
 * @param hasDefault - Whether current pattern is wrapped in AssignmentPattern (internal)
 * @returns Array of extracted variable bindings with metadata
 *
 * @example
 * // Simple object destructuring
 * const { x, y } = obj;
 * // Returns: [
 * //   { name: 'x', loc: {...}, propertyPath: ['x'] },
 * //   { name: 'y', loc: {...}, propertyPath: ['y'] }
 * // ]
 *
 * @example
 * // Nested with defaults
 * const { data: { user = 'guest' } } = response;
 * // Returns: [
 * //   { name: 'user', loc: {...}, propertyPath: ['data', 'user'], hasDefault: true }
 * // ]
 *
 * @example
 * // Array with rest
 * const [first, ...rest] = items;
 * // Returns: [
 * //   { name: 'first', loc: {...}, arrayIndex: 0 },
 * //   { name: 'rest', loc: {...}, arrayIndex: 1, isRest: true }
 * // ]
 */
export function extractNamesFromPattern(
  pattern: t.Node | null | undefined,
  variables: ExtractedVariable[] = [],
  propertyPath: string[] = [],
  hasDefault: boolean = false
): ExtractedVariable[] {
  if (!pattern) return variables;

  // Base case: Identifier (leaf node)
  if (t.isIdentifier(pattern)) {
    variables.push({
      name: pattern.name,
      loc: pattern.loc?.start ? { start: pattern.loc.start } : { start: { line: 0, column: 0 } },
      propertyPath: propertyPath.length > 0 ? [...propertyPath] : undefined,
      hasDefault: hasDefault || undefined  // Only set if true
    });
  }
  // Object destructuring: { x, y, data: { user } }
  else if (t.isObjectPattern(pattern)) {
    pattern.properties.forEach((prop) => {
      // Rest element: { a, ...rest }
      if (t.isRestElement(prop)) {
        const restVars = extractNamesFromPattern(prop.argument, [], [], hasDefault);
        restVars.forEach(v => {
          v.isRest = true;
          v.propertyPath = propertyPath.length > 0 ? [...propertyPath] : undefined;
          variables.push(v);
        });
      }
      // Regular property: { x } or { data: { user } }
      else if (t.isObjectProperty(prop) && prop.value) {
        // Extract property key (name in source object)
        const key = t.isIdentifier(prop.key) ? prop.key.name :
                   (t.isStringLiteral(prop.key) || t.isNumericLiteral(prop.key) ? String(prop.key.value) : null);

        if (key !== null) {
          // Extend property path for nested destructuring
          const newPath = [...propertyPath, key];
          extractNamesFromPattern(prop.value, variables, newPath, hasDefault);
        } else {
          // Computed property names - skip path tracking
          extractNamesFromPattern(prop.value, variables, propertyPath, hasDefault);
        }
      }
    });
  }
  // Array destructuring: [first, second] or [, , third]
  else if (t.isArrayPattern(pattern)) {
    pattern.elements.forEach((element, index) => {
      if (element) {
        // Rest element: [first, ...rest]
        if (t.isRestElement(element)) {
          const restVars = extractNamesFromPattern(element.argument, [], [], hasDefault);
          restVars.forEach(v => {
            v.isRest = true;
            v.arrayIndex = index;
            v.propertyPath = propertyPath.length > 0 ? [...propertyPath] : undefined;
            variables.push(v);
          });
        }
        // Regular element: [first] or [{ x }] (nested)
        else {
          const extracted = extractNamesFromPattern(element, [], propertyPath, hasDefault);
          extracted.forEach(v => {
            v.arrayIndex = index;
            variables.push(v);
          });
        }
      }
      // null/undefined element (sparse array: [, , third])
      // Skip - no binding
    });
  }
  // Rest element (standalone, handled by parent patterns)
  else if (t.isRestElement(pattern)) {
    const restVars = extractNamesFromPattern(pattern.argument, [], propertyPath, hasDefault);
    restVars.forEach(v => {
      v.isRest = true;
      variables.push(v);
    });
  }
  // AssignmentPattern: default values (x = 42, { x } = {}, [x] = [])
  else if (t.isAssignmentPattern(pattern)) {
    // Recurse on the left side (the pattern), marking hasDefault=true
    extractNamesFromPattern(pattern.left, variables, propertyPath, true);
  }

  return variables;
}
