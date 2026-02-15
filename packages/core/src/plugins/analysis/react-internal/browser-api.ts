/**
 * Browser API detection for React analysis.
 *
 * Detects usage of browser APIs (timers, storage, DOM, history,
 * clipboard, geolocation, canvas, media queries) within React code.
 *
 * @module react-internal/browser-api
 */
import type { NodePath } from '@babel/traverse';
import type { CallExpression } from '@babel/types';
import { getLine } from '../ast/utils/location.js';
import { getMemberExpressionName } from '../ast/utils/getMemberExpressionName.js';
import { BROWSER_APIS } from './types.js';
import type { AnalysisResult } from './types.js';

/**
 * Analyze a CallExpression for browser API usage.
 *
 * Detects direct calls (setTimeout, fetch, alert) and member expressions
 * (localStorage.setItem, document.querySelector, etc.) and adds them
 * to the analysis result.
 */
export function analyzeBrowserAPI(
  path: NodePath<CallExpression>,
  filePath: string,
  analysis: AnalysisResult
): void {
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
    const fullName = getMemberExpressionName(callee);

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
