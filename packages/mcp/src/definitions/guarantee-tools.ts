/**
 * Guarantee Tools — creating, checking, and managing code guarantees
 */

import type { ToolDefinition } from './types.js';

export const GUARANTEE_TOOLS: ToolDefinition[] = [
  {
    name: 'create_guarantee',
    description: `Create a new code guarantee.

Two types supported:
1. Datalog-based: Uses rule field with Datalog query (violation/1)
2. Contract-based: Uses type + schema for JSON validation

Examples:
- Datalog: name="no-eval" rule="violation(X) :- node(X, \"CALL\"), attr(X, \"name\", \"eval\")."
- Contract: name="orders" type="guarantee:queue" priority="critical" schema={...}`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for the guarantee',
        },
        // Datalog-based fields
        rule: {
          type: 'string',
          description: 'Datalog rule defining violation/1 (for Datalog-based guarantees)',
        },
        severity: {
          type: 'string',
          description: 'Severity for Datalog guarantees: error, warning, or info',
          enum: ['error', 'warning', 'info'],
        },
        // Contract-based fields
        type: {
          type: 'string',
          description: 'Guarantee type for contract-based: guarantee:queue, guarantee:api, guarantee:permission',
          enum: ['guarantee:queue', 'guarantee:api', 'guarantee:permission'],
        },
        priority: {
          type: 'string',
          description: 'Priority level: critical, important, observed, tracked',
          enum: ['critical', 'important', 'observed', 'tracked'],
        },
        status: {
          type: 'string',
          description: 'Lifecycle status: discovered, reviewed, active, changing, deprecated',
          enum: ['discovered', 'reviewed', 'active', 'changing', 'deprecated'],
        },
        owner: {
          type: 'string',
          description: 'Owner of the guarantee (team or person)',
        },
        schema: {
          type: 'object',
          description: 'JSON Schema for contract-based validation',
        },
        condition: {
          type: 'string',
          description: 'Condition expression for the guarantee',
        },
        description: {
          type: 'string',
          description: 'Human-readable description',
        },
        governs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Node IDs that this guarantee governs',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_guarantees',
    description: `List all defined code guarantees (rules and contracts).

Use this to:
- See existing invariants: "What rules does this codebase enforce?"
- Understand code contracts before modifying code
- Find Datalog-based rules (e.g., "no-eval", "no-sql-injection")
- List contract-based guarantees (queue schemas, API contracts)

Returns for each guarantee: name, type, description, rule/schema, priority, status.
Use BEFORE check_guarantees to see what will be validated.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_guarantees',
    description: `Validate code against defined guarantees and return violations.

Use this to:
- Find violations: Run all rules, get list of breaking code
- Verify specific rule: check_guarantees(names=["no-eval"]) — test one guarantee
- Pre-commit validation: Catch issues before code review
- After code changes: Verify you didn't break existing rules

Returns: Violations array with node IDs, file, line, rule name.
Empty array = all guarantees pass.`,
    inputSchema: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of guarantee names to check (omit to check all)',
        },
      },
    },
  },
  {
    name: 'delete_guarantee',
    description: `Delete a guarantee by name.

Use this when:
- A guarantee is no longer relevant to the codebase
- Replacing a guarantee with a new version (delete old, create new)
- Cleaning up experimental guarantees after testing

This permanently removes the guarantee. Use list_guarantees first to verify the name.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of guarantee to delete',
        },
      },
      required: ['name'],
    },
  },
];
