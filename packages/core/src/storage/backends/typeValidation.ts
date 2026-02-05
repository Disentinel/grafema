/**
 * Type Validation Utilities
 *
 * Levenshtein distance and typo detection for node/edge types.
 * Extracted from ReginaFlowBackend for use in multiple contexts.
 */

// Known node types - source of truth for validation
// Initial set of types, dynamically expanded as new valid types are encountered
const KNOWN_NODE_TYPES = new Set<string>([
  // Base types
  'FUNCTION', 'CLASS', 'METHOD', 'VARIABLE', 'PARAMETER', 'CONSTANT', 'LITERAL',
  'MODULE', 'IMPORT', 'EXPORT', 'CALL', 'PROJECT', 'SERVICE', 'FILE', 'SCOPE',
  'EXTERNAL', 'EXTERNAL_MODULE', 'SIDE_EFFECT',
  // Namespaced types - HTTP/Express
  'http:route', 'http:request',
  'express:router', 'express:middleware', 'express:mount',
  // Namespaced types - Socket.IO
  'socketio:emit', 'socketio:on', 'socketio:namespace', 'socketio:room',
  // Namespaced types - Database
  'db:query', 'db:connection', 'db:table',
  // Namespaced types - File System
  'fs:read', 'fs:write', 'fs:operation',
  // Namespaced types - Network/IO
  'net:request', 'net:stdio',
  // Namespaced types - Events
  'event:listener', 'event:emit',
  // Service layer types (legacy, to be refactored)
  'SERVICE_CLASS', 'SERVICE_INSTANCE', 'SERVICE_REGISTRATION', 'SERVICE_USAGE',
  // Guarantees/Invariants
  'GUARANTEE',
]);

// Store initial types for reset
const INITIAL_NODE_TYPES = [...KNOWN_NODE_TYPES];

// Known edge types - source of truth for validation
const KNOWN_EDGE_TYPES = new Set<string>([
  // Base edge types
  'UNKNOWN', 'CONTAINS', 'DEPENDS_ON', 'CALLS', 'EXTENDS', 'IMPLEMENTS',
  'USES', 'DEFINES', 'IMPORTS', 'EXPORTS', 'ROUTES_TO', 'HAS_SCOPE',
  'CAPTURES', 'MODIFIES', 'DECLARES', 'WRITES_TO', 'INSTANCE_OF',
  'HAS_CALLBACK', 'IMPORTS_FROM', 'HANDLED_BY', 'MAKES_REQUEST',
  'PASSES_ARGUMENT', 'ASSIGNED_FROM', 'EXPORTS_TO', 'MOUNTS', 'EXPOSES',
  'INTERACTS_WITH', 'CALLS_API', 'LISTENS_TO', 'JOINS_ROOM', 'EMITS_EVENT',
  'RETURNS', 'RECEIVES_ARGUMENT', 'READS_FROM', 'THROWS', 'REGISTERS_VIEW',
  'GOVERNS', 'VIOLATES', 'HAS_PARAMETER', 'DERIVES_FROM',
  'RESOLVES_TO',  // Promise resolve() data flow
  'YIELDS',       // Generator yield data flow (REG-270)
  'DELEGATES_TO', // Generator yield* delegation (REG-270)
]);

// Store initial edge types for reset
const INITIAL_EDGE_TYPES = [...KNOWN_EDGE_TYPES];

export interface TypoCheckResult {
  isTooSimilar: boolean;
  similarTo: string | null;
}

/**
 * Levenshtein distance for typo detection
 */
export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Check if a type is too similar to any existing known type (possible typo)
 */
export function checkTypoAgainstKnownTypes(newType: string): TypoCheckResult {
  const newTypeLower = newType.toLowerCase();
  for (const known of KNOWN_NODE_TYPES) {
    const dist = levenshtein(newTypeLower, known.toLowerCase());
    if (dist > 0 && dist <= 2) {
      return { isTooSimilar: true, similarTo: known };
    }
  }
  return { isTooSimilar: false, similarTo: null };
}

/**
 * Reset KNOWN_NODE_TYPES to initial state (for testing)
 */
export function resetKnownNodeTypes(): void {
  KNOWN_NODE_TYPES.clear();
  for (const t of INITIAL_NODE_TYPES) {
    KNOWN_NODE_TYPES.add(t);
  }
}

/**
 * Get current known node types (for testing/debugging)
 */
export function getKnownNodeTypes(): Set<string> {
  return new Set(KNOWN_NODE_TYPES);
}

/**
 * Check if an edge type is too similar to any existing known edge type (possible typo)
 */
export function checkTypoAgainstKnownEdgeTypes(newType: string): TypoCheckResult {
  const newTypeLower = newType.toLowerCase();
  for (const known of KNOWN_EDGE_TYPES) {
    const dist = levenshtein(newTypeLower, known.toLowerCase());
    if (dist > 0 && dist <= 2) {
      return { isTooSimilar: true, similarTo: known };
    }
  }
  return { isTooSimilar: false, similarTo: null };
}

/**
 * Reset KNOWN_EDGE_TYPES to initial state (for testing)
 */
export function resetKnownEdgeTypes(): void {
  KNOWN_EDGE_TYPES.clear();
  for (const t of INITIAL_EDGE_TYPES) {
    KNOWN_EDGE_TYPES.add(t);
  }
}

/**
 * Get current known edge types (for testing/debugging)
 */
export function getKnownEdgeTypes(): Set<string> {
  return new Set(KNOWN_EDGE_TYPES);
}

/**
 * Add a new node type to the known types set
 */
export function addKnownNodeType(nodeType: string): void {
  KNOWN_NODE_TYPES.add(nodeType);
}

/**
 * Add a new edge type to the known types set
 */
export function addKnownEdgeType(edgeType: string): void {
  KNOWN_EDGE_TYPES.add(edgeType);
}
