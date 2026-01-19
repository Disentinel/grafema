/**
 * Deterministic Node ID generation scheme for the graph
 *
 * Format: TYPE|SCOPE|FILE|IDENTIFIER|LINE:COL
 *
 * Components:
 * - TYPE: node type (MODULE, FUNCTION, CLASS, METHOD, VARIABLE, etc.)
 * - SCOPE: context/scope (path to parent or project)
 * - FILE: relative file path from project root
 * - IDENTIFIER: entity name (for MODULE can be empty)
 * - LINE:COL: position in file (for uniqueness of anonymous functions)
 *
 * Examples:
 * MODULE|/project|src/index.js||0:0
 * FUNCTION|/project|src/index.js|handleRequest|42:5
 * CLASS|/project|src/User.js|User|10:0
 * METHOD|User|src/User.js|login|25:2
 * VARIABLE|handleRequest|src/index.js|userId|45:10
 * EXTERNAL_MODULE|/project||express|0:0
 */

import { createHash } from 'crypto';

/**
 * Parameters for computing Node ID
 */
export interface NodeIdParams {
  type: string;
  scope?: string;
  file?: string;
  identifier?: string;
  line?: number;
  column?: number;
}

/**
 * Parsed Node ID components
 */
export interface ParsedNodeId {
  type: string;
  scope: string;
  file: string;
  identifier: string;
  line: number;
  column: number;
}

/**
 * Compute deterministic Node ID
 */
export function computeNodeId({
  type,
  scope = '',
  file = '',
  identifier = '',
  line = 0,
  column = 0
}: NodeIdParams): string {
  // Normalize: remove empty values
  const parts = [
    type,
    scope || '',
    file || '',
    identifier || '',
    `${line}:${column}`
  ];

  return parts.join('|');
}

/**
 * Compute u128 numeric ID from string (for Rust backend)
 * Uses SHA-256 hash and takes first 16 bytes
 */
export function computeNumericId(stringId: string): bigint {
  const hash = createHash('sha256').update(stringId).digest();

  // Take first 16 bytes (128 bits) and convert to BigInt
  let numericId = 0n;
  for (let i = 0; i < 16; i++) {
    numericId = (numericId << 8n) | BigInt(hash[i]);
  }

  return numericId;
}

/**
 * Parse Node ID back into components
 */
export function parseNodeId(nodeId: string): ParsedNodeId {
  const parts = nodeId.split('|');

  if (parts.length !== 5) {
    throw new Error(`Invalid Node ID format: ${nodeId}`);
  }

  const [lineStr, columnStr] = parts[4].split(':');

  return {
    type: parts[0],
    scope: parts[1],
    file: parts[2],
    identifier: parts[3],
    line: Number(lineStr),
    column: Number(columnStr)
  };
}

/**
 * Helper for creating MODULE ID
 */
export function createModuleId(filePath: string, projectPath: string = '/project'): string {
  return computeNodeId({
    type: 'MODULE',
    scope: projectPath,
    file: filePath,
    identifier: '',
    line: 0,
    column: 0
  });
}

/**
 * Helper for creating FUNCTION ID
 */
export function createFunctionId(
  filePath: string,
  functionName: string,
  line: number,
  column: number,
  scope: string = '/project'
): string {
  return computeNodeId({
    type: 'FUNCTION',
    scope,
    file: filePath,
    identifier: functionName,
    line,
    column
  });
}

/**
 * Helper for creating CLASS ID
 */
export function createClassId(
  filePath: string,
  className: string,
  line: number,
  column: number,
  scope: string = '/project'
): string {
  return computeNodeId({
    type: 'CLASS',
    scope,
    file: filePath,
    identifier: className,
    line,
    column
  });
}

/**
 * Helper for creating METHOD ID
 */
export function createMethodId(
  filePath: string,
  className: string,
  methodName: string,
  line: number,
  column: number
): string {
  return computeNodeId({
    type: 'METHOD',
    scope: className, // Scope = parent class
    file: filePath,
    identifier: methodName,
    line,
    column
  });
}

/**
 * Helper for creating VARIABLE ID
 */
export function createVariableId(
  filePath: string,
  varName: string,
  line: number,
  column: number,
  scope: string
): string {
  return computeNodeId({
    type: 'VARIABLE',
    scope, // Scope = containing function/class
    file: filePath,
    identifier: varName,
    line,
    column
  });
}

/**
 * Helper for creating EXTERNAL_MODULE ID
 */
export function createExternalModuleId(
  moduleName: string,
  projectPath: string = '/project'
): string {
  return computeNodeId({
    type: 'EXTERNAL_MODULE',
    scope: projectPath,
    file: '',
    identifier: moduleName,
    line: 0,
    column: 0
  });
}

/**
 * Helper for creating IMPORT ID
 */
export function createImportId(
  filePath: string,
  source: string,
  localName: string,
  line: number,
  scope: string = '/project'
): string {
  return computeNodeId({
    type: 'IMPORT',
    scope,
    file: filePath,
    identifier: `${source}:${localName}`,
    line,
    column: 0
  });
}

/**
 * Helper for creating EXPORT ID
 */
export function createExportId(
  filePath: string,
  exportName: string,
  line: number,
  scope: string = '/project'
): string {
  return computeNodeId({
    type: 'EXPORT',
    scope,
    file: filePath,
    identifier: exportName,
    line,
    column: 0
  });
}
