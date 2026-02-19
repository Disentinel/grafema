/**
 * Shared utilities for Grafema VS Code extension.
 *
 * Contains pure functions extracted from extension.ts and edgesProvider.ts
 * to enable reuse across multiple providers.
 */

import * as vscode from 'vscode';

/**
 * Debounce a function call by delay milliseconds.
 * If called again before delay expires, resets the timer.
 *
 * @param fn - Async or sync function to debounce
 * @param delay - Milliseconds to wait before calling fn
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void | Promise<void>,
  delay: number
): (...args: Args) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Args) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Map node type to VS Code icon name for QuickPick labels.
 * Returns 'misc' for unknown types.
 */
export function getIconName(nodeType: string): string {
  const map: Record<string, string> = {
    FUNCTION: 'function',
    METHOD: 'method',
    CLASS: 'class',
    VARIABLE: 'variable',
    PARAMETER: 'parameter',
    CONSTANT: 'constant',
    MODULE: 'module',
    IMPORT: 'package',
    EXPORT: 'event',
    FILE: 'file',
  };
  return map[nodeType] || 'misc';
}

/**
 * Get VS Code ThemeIcon for a node type.
 * Used in EdgesProvider, ValueTraceProvider, and other tree views.
 */
export function getNodeIcon(nodeType: string): vscode.ThemeIcon {
  const iconMap: Record<string, string> = {
    FUNCTION: 'symbol-function',
    METHOD: 'symbol-method',
    CLASS: 'symbol-class',
    VARIABLE: 'symbol-variable',
    PARAMETER: 'symbol-parameter',
    CONSTANT: 'symbol-constant',
    MODULE: 'symbol-module',
    IMPORT: 'package',
    EXPORT: 'export',
    CALL: 'call-outgoing',
    FILE: 'file-code',
    SCOPE: 'bracket',
    BRANCH: 'git-branch',
    LOOP: 'sync',
    LITERAL: 'symbol-string',
    EXPRESSION: 'symbol-operator',
  };

  const iconName = iconMap[nodeType] || 'symbol-misc';
  return new vscode.ThemeIcon(iconName);
}
