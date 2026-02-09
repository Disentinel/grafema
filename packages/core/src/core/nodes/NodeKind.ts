/**
 * Node Types - string type system for nodes
 *
 * Base types: FUNCTION, CLASS, METHOD, etc.
 * Namespaced types: http:route, socketio:emit, express:router, etc.
 *
 * Namespace convention:
 * - http:* - HTTP endpoints and requests
 * - express:* - Express.js specifics
 * - socketio:* - Socket.IO
 * - db:* - Database queries
 * - fs:* - Filesystem operations
 */

// === BASE TYPES ===
// Abstract types, not tied to language or framework

export const NODE_TYPE = {
  // Core code entities
  FUNCTION: 'FUNCTION',
  CLASS: 'CLASS',
  METHOD: 'METHOD',
  VARIABLE: 'VARIABLE',
  PARAMETER: 'PARAMETER',
  CONSTANT: 'CONSTANT',
  LITERAL: 'LITERAL',
  EXPRESSION: 'EXPRESSION',  // Generic expression node for data flow tracking

  // Module system
  MODULE: 'MODULE',
  IMPORT: 'IMPORT',
  EXPORT: 'EXPORT',

  // Call graph
  CALL: 'CALL', // unified METHOD_CALL + CALL_SITE

  // Project structure
  PROJECT: 'PROJECT',
  SERVICE: 'SERVICE',
  FILE: 'FILE',
  SCOPE: 'SCOPE',

  // External dependencies
  EXTERNAL: 'EXTERNAL',
  EXTERNAL_MODULE: 'EXTERNAL_MODULE',

  // Generic side effects
  SIDE_EFFECT: 'SIDE_EFFECT',
} as const;

export type BaseNodeType = typeof NODE_TYPE[keyof typeof NODE_TYPE];

// === NAMESPACED TYPES ===
// Types specific to frameworks and libraries

export const NAMESPACED_TYPE = {
  // HTTP (generic)
  HTTP_ROUTE: 'http:route',
  HTTP_REQUEST: 'http:request',

  // Express.js
  EXPRESS_ROUTER: 'express:router',
  EXPRESS_MIDDLEWARE: 'express:middleware',
  EXPRESS_MOUNT: 'express:mount',

  // Socket.IO
  SOCKETIO_EMIT: 'socketio:emit',
  SOCKETIO_ON: 'socketio:on',
  SOCKETIO_NAMESPACE: 'socketio:namespace',

  // Database
  DB_QUERY: 'db:query',
  DB_CONNECTION: 'db:connection',

  // Filesystem
  FS_READ: 'fs:read',
  FS_WRITE: 'fs:write',
  FS_OPERATION: 'fs:operation',

  // Network
  NET_REQUEST: 'net:request',
  NET_STDIO: 'net:stdio',

  // Events
  EVENT_LISTENER: 'event:listener',
  EVENT_EMIT: 'event:emit',

  // Guarantees (contract-based)
  GUARANTEE_QUEUE: 'guarantee:queue',
  GUARANTEE_API: 'guarantee:api',
  GUARANTEE_PERMISSION: 'guarantee:permission',

  // Grafema internal (self-describing pipeline)
  GRAFEMA_PLUGIN: 'grafema:plugin',
} as const;

export type NamespacedNodeType = typeof NAMESPACED_TYPE[keyof typeof NAMESPACED_TYPE];

// Combined node type
export type NodeType = BaseNodeType | NamespacedNodeType | string;

// === HELPERS ===

/**
 * Check if type is namespaced (contains :)
 */
export function isNamespacedType(nodeType: string): boolean {
  return nodeType !== undefined && nodeType !== null && nodeType.includes(':');
}

/**
 * Get namespace from type
 * @returns namespace or null for base types
 */
export function getNamespace(nodeType: string): string | null {
  if (!nodeType || !nodeType.includes(':')) return null;
  return nodeType.split(':')[0];
}

/**
 * Get base name from namespaced type
 */
export function getBaseName(nodeType: string): string {
  if (!nodeType) return '';
  if (!nodeType.includes(':')) return nodeType;
  return nodeType.split(':').slice(1).join(':');
}

/**
 * Check if type is an endpoint (HTTP route, WebSocket handler, etc.)
 */
export function isEndpointType(nodeType: string): boolean {
  if (!nodeType) return false;
  const ns = getNamespace(nodeType);
  return ns === 'http' || ns === 'express' || ns === 'socketio';
}

/**
 * Check if type is a side effect (DB, FS, Network)
 */
export function isSideEffectType(nodeType: string): boolean {
  if (!nodeType) return false;
  if (nodeType === NODE_TYPE.SIDE_EFFECT) return true;
  const ns = getNamespace(nodeType);
  return ns === 'db' || ns === 'fs' || ns === 'net';
}

/**
 * Check if type matches a pattern with wildcard
 * @param nodeType - node type
 * @param pattern - pattern (e.g., "http:*", "FUNCTION")
 */
export function matchesTypePattern(nodeType: string, pattern: string): boolean {
  if (!nodeType || !pattern) return false;

  // Exact match
  if (nodeType === pattern) return true;

  // Wildcard match (e.g., "http:*" matches "http:route")
  if (pattern.endsWith(':*')) {
    const patternNs = pattern.slice(0, -2);
    return getNamespace(nodeType) === patternNs;
  }

  return false;
}

/**
 * Check if type is a guarantee type (guarantee:queue, guarantee:api, etc.)
 */
export function isGuaranteeType(nodeType: string): boolean {
  if (!nodeType) return false;
  return getNamespace(nodeType) === 'guarantee';
}

/**
 * Check if type is a grafema internal type (grafema:plugin, etc.)
 */
export function isGrafemaType(nodeType: string): boolean {
  if (!nodeType) return false;
  return getNamespace(nodeType) === 'grafema';
}
