/**
 * Edge Types - graph edge type definitions
 */

// === EDGE TYPES ===
export const EDGE_TYPE = {
  // Structure
  CONTAINS: 'CONTAINS',
  DEPENDS_ON: 'DEPENDS_ON',
  HAS_SCOPE: 'HAS_SCOPE',

  // Branching
  HAS_CONDITION: 'HAS_CONDITION',
  HAS_CASE: 'HAS_CASE',
  HAS_DEFAULT: 'HAS_DEFAULT',

  // Loop edges
  HAS_BODY: 'HAS_BODY',           // LOOP -> body SCOPE
  ITERATES_OVER: 'ITERATES_OVER', // LOOP -> collection VARIABLE (for-in/for-of)
  HAS_INIT: 'HAS_INIT',           // LOOP (for) -> init VARIABLE (let i = 0)
  HAS_UPDATE: 'HAS_UPDATE',       // LOOP (for) -> update EXPRESSION (i++)

  // If statement edges
  HAS_CONSEQUENT: 'HAS_CONSEQUENT', // BRANCH -> then SCOPE
  HAS_ALTERNATE: 'HAS_ALTERNATE',   // BRANCH -> else SCOPE

  // Try/catch/finally edges
  HAS_CATCH: 'HAS_CATCH',     // TRY_BLOCK -> CATCH_BLOCK
  HAS_FINALLY: 'HAS_FINALLY', // TRY_BLOCK -> FINALLY_BLOCK

  // Calls
  CALLS: 'CALLS',
  HAS_CALLBACK: 'HAS_CALLBACK',
  PASSES_ARGUMENT: 'PASSES_ARGUMENT',
  RECEIVES_ARGUMENT: 'RECEIVES_ARGUMENT',
  RETURNS: 'RETURNS',
  YIELDS: 'YIELDS',
  DELEGATES_TO: 'DELEGATES_TO',

  // Class members
  HAS_MEMBER: 'HAS_MEMBER',       // CLASS -> METHOD / PROPERTY / STATIC_BLOCK

  // Inheritance
  EXTENDS: 'EXTENDS',
  IMPLEMENTS: 'IMPLEMENTS',
  INSTANCE_OF: 'INSTANCE_OF',

  // Imports/Exports
  IMPORTS: 'IMPORTS',
  EXPORTS: 'EXPORTS',
  IMPORTS_FROM: 'IMPORTS_FROM',

  // Variables/Data flow
  DEFINES: 'DEFINES',
  USES: 'USES',
  DECLARES: 'DECLARES',
  MODIFIES: 'MODIFIES',
  CAPTURES: 'CAPTURES',
  ASSIGNED_FROM: 'ASSIGNED_FROM',
  READS_FROM: 'READS_FROM',
  WRITES_TO: 'WRITES_TO',
  DERIVES_FROM: 'DERIVES_FROM',
  FLOWS_INTO: 'FLOWS_INTO',
  ELEMENT_OF: 'ELEMENT_OF',   // X is an element/value of collection Y (for-of, destructuring, array methods)
  KEY_OF: 'KEY_OF',           // X is a key of collection Y (for-in)

  // Object/Array structure
  HAS_PROPERTY: 'HAS_PROPERTY',   // OBJECT_LITERAL -> property value
  HAS_ELEMENT: 'HAS_ELEMENT',     // ARRAY_LITERAL -> element

  // HTTP/Routing
  ROUTES_TO: 'ROUTES_TO',
  HANDLED_BY: 'HANDLED_BY',
  MAKES_REQUEST: 'MAKES_REQUEST',
  MOUNTS: 'MOUNTS',
  EXPOSES: 'EXPOSES',
  RESPONDS_WITH: 'RESPONDS_WITH',

  // Events/Sockets
  LISTENS_TO: 'LISTENS_TO',
  EMITS_EVENT: 'EMITS_EVENT',
  JOINS_ROOM: 'JOINS_ROOM',

  // External
  CALLS_API: 'CALLS_API',
  INTERACTS_WITH: 'INTERACTS_WITH',
  HTTP_RECEIVES: 'HTTP_RECEIVES',

  // Views
  REGISTERS_VIEW: 'REGISTERS_VIEW',

  // Errors
  THROWS: 'THROWS',

  // REG-311: Async error flow
  REJECTS: 'REJECTS',           // FUNCTION -> CLASS (error class it can reject)
  CATCHES_FROM: 'CATCHES_FROM', // CATCH_BLOCK -> error sources in TRY_BLOCK

  // Guarantees/Invariants
  GOVERNS: 'GOVERNS',
  VIOLATES: 'VIOLATES',

  // Issues
  AFFECTS: 'AFFECTS',

  // === Cross-Layer Edges (USG) ===
  // Code -> Abstract Resources
  DEPLOYED_TO: 'DEPLOYED_TO',
  SCHEDULED_BY: 'SCHEDULED_BY',
  EXPOSED_VIA: 'EXPOSED_VIA',
  USES_CONFIG: 'USES_CONFIG',
  USES_SECRET: 'USES_SECRET',
  PUBLISHES_TO: 'PUBLISHES_TO',
  SUBSCRIBES_TO: 'SUBSCRIBES_TO',
  MONITORED_BY: 'MONITORED_BY',
  MEASURED_BY: 'MEASURED_BY',
  LOGS_TO: 'LOGS_TO',
  INVOKES_FUNCTION: 'INVOKES_FUNCTION',
  // Abstract -> Concrete (tool provenance)
  PROVISIONED_BY: 'PROVISIONED_BY',

  // Redis
  PERFORMS_REDIS: 'PERFORMS_REDIS',

  // Unknown/fallback
  UNKNOWN: 'UNKNOWN',
} as const;

export type EdgeType = typeof EDGE_TYPE[keyof typeof EDGE_TYPE] | string;

// === EDGE RECORD ===
export interface EdgeRecord {
  src: string;
  dst: string;
  type: EdgeType;
  index?: number;
  metadata?: Record<string, unknown>;
}

// Semantic edge types for better type inference
export interface ContainsEdge extends EdgeRecord {
  type: 'CONTAINS';
}

export interface CallsEdge extends EdgeRecord {
  type: 'CALLS';
  argumentCount?: number;
}

export interface ImportsEdge extends EdgeRecord {
  type: 'IMPORTS';
  specifier?: string;
  isDefault?: boolean;
}

/** EXPORT node → entity it exports (FUNCTION, VARIABLE, CLASS, etc.) or re-export target */
export interface ExportsEdge extends EdgeRecord {
  type: 'EXPORTS';
}

export interface DataFlowEdge extends EdgeRecord {
  type: 'ASSIGNED_FROM' | 'READS_FROM' | 'WRITES_TO' | 'PASSES_ARGUMENT' | 'DERIVES_FROM' | 'FLOWS_INTO';
  dataType?: string;
}

/**
 * Edge representing an element/value relationship with a collection.
 * Source: the element (VARIABLE, PARAMETER, CALL)
 * Destination: the collection (VARIABLE, PARAMETER)
 *
 * Example: `for (const item of arr)` → item --ELEMENT_OF--> arr
 */
export interface ElementOfEdge extends EdgeRecord {
  type: 'ELEMENT_OF';
  metadata?: { via: 'for-of' | 'for-in' | 'destructuring' | 'method-callback' | 'method-return' | 'computed-access' | 'Object.values' | 'Object.entries' };
}

/**
 * Edge representing a key relationship with a collection.
 * Source: the key (VARIABLE, PARAMETER, CALL)
 * Destination: the collection (VARIABLE, PARAMETER)
 *
 * Example: `for (const key in obj)` → key --KEY_OF--> obj
 */
export interface KeyOfEdge extends EdgeRecord {
  type: 'KEY_OF';
  metadata?: { via: 'for-in' | 'Object.keys' | 'Object.entries' };
}

/**
 * Edge representing data flowing INTO a container (array, collection)
 * Source: the value being added
 * Destination: the container receiving the value
 *
 * Example: arr.push(obj) creates edge obj --FLOWS_INTO--> arr
 */
export interface FlowsIntoEdge extends EdgeRecord {
  type: 'FLOWS_INTO';
  mutationMethod?: 'push' | 'unshift' | 'splice' | 'indexed';
  argIndex?: number;
  isSpread?: boolean;
}

export interface ObjectStructureEdge extends EdgeRecord {
  type: 'HAS_PROPERTY' | 'HAS_ELEMENT';
  propertyName?: string;  // For HAS_PROPERTY
  elementIndex?: number;  // For HAS_ELEMENT
}

export interface RouteEdge extends EdgeRecord {
  type: 'ROUTES_TO' | 'HANDLED_BY';
  method?: string;
  path?: string;
}

/**
 * Edge from LOOP to iterated collection (for-in/for-of loops)
 * Source: LOOP node
 * Destination: VARIABLE or PARAMETER being iterated
 */
export interface IteratesOverEdge extends EdgeRecord {
  type: 'ITERATES_OVER';
  metadata?: {
    /** What the loop iterates over: 'keys' for for-in, 'values' for for-of */
    iterates: 'keys' | 'values';
  };
}
