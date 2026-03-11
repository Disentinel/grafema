/**
 * Notation Tools — describe tool definition
 *
 * The `describe` tool renders a node's neighborhood as compact DSL notation,
 * replacing verbose edge listings with archetype-grouped visual operators.
 */

import type { ToolDefinition } from './types.js';

export const NOTATION_TOOLS: ToolDefinition[] = [
  {
    name: 'describe',
    description: `Render a node's neighborhood as compact Grafema DSL notation.

Reduces verbose edge listings to archetype-grouped visual operators:
  o-  dependency/import
  >   outward flow (calls, delegates, passes)
  <   inward flow (reads, extends, receives)
  =>  persistent write (db, file, redis)
  >x  exception (throws, rejects)
  ~>> event/message (emits, publishes)
  ?|  conditional guard (if, case)
  |=  governance (governs, monitors)

Containment edges ({ }) define nesting structure.

Example output:
  login {
    o- imports bcrypt
    > calls UserDB.findByEmail, createToken
    < reads config.auth
    => writes session
    >x throws AuthError
    ~>> emits 'auth:login'
  }

Use depth to control detail:
  0 = names only (children listed, no edges)
  1 = edges (default — shows all relationship lines)
  2 = nested (expands children's children)

10-30 lines vs 500+ lines of raw edge data. Ideal for LLM context windows.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Semantic ID, file path, or node name to describe',
        },
        depth: {
          type: 'number',
          description: 'Level of detail: 0=names, 1=edges (default), 2=nested',
        },
        perspective: {
          type: 'string',
          description: 'Archetype filter preset: "security" (write,exception), "data" (flow_out,flow_in,write), "errors" (exception), "api" (flow_out,publishes,depends), "events" (publishes)',
          enum: ['security', 'data', 'errors', 'api', 'events'],
        },
      },
      required: ['target'],
    },
  },
];
