/**
 * OxcAdapter - адаптер для перехода с Babel на Oxc parser
 * Предоставляет API совместимый с Babel parse и traverse
 */

import { parseSync, Visitor } from 'oxc-parser';
import type * as t from '@babel/types';

/**
 * Parse options
 */
interface ParseOptions {
  filename?: string;
  sourceType?: 'module' | 'script';
  plugins?: string[];
}

/**
 * Visitor handlers type
 */
interface VisitorHandlers {
  [key: string]: ((node: t.Node) => void) | undefined;
}

/**
 * Parse code with Oxc (compatible with Babel parse API)
 * @param code - Source code to parse
 * @param options - Parse options
 * @returns AST with program property
 */
export function parse(code: string, options: ParseOptions = {}): t.Program {
  // Oxc doesn't need sourceType or plugins config
  // It auto-detects JSX and handles all modern syntax
  const filename = options.filename || 'unknown.js';

  const result = parseSync(filename, code);

  // Oxc returns { program, comments, errors }
  // Babel returns just the program node
  // For compatibility, return the program directly
  return result.program as unknown as t.Program;
}

/**
 * Traverse AST with Oxc Visitor (compatible with Babel traverse API)
 * @param ast - AST to traverse
 * @param visitors - Visitor handlers
 */
export function traverse(ast: t.Node, visitors: VisitorHandlers): void {
  // Oxc Visitor accepts an object with node type handlers
  // This is already compatible with our Babel usage pattern
  const visitor = new Visitor(visitors as unknown as Record<string, (node: unknown) => void>);
  // Cast to Oxc Program through unknown - types are structurally similar but from different packages
  visitor.visit(ast as unknown as Parameters<typeof visitor.visit>[0]);
}

/**
 * Default export for compatibility
 */
export default {
  parse,
  traverse
};
