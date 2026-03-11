/**
 * MCP Documentation Handlers
 */

import { getOnboardingInstruction } from '@grafema/util';
import {
  textResult,
} from '../utils.js';
import type {
  ToolResult,
  GetDocumentationArgs,
} from '../types.js';

// === DOCUMENTATION ===

export async function handleGetDocumentation(args: GetDocumentationArgs): Promise<ToolResult> {
  const { topic = 'overview' } = args;

  const docs: Record<string, string> = {
    onboarding: getOnboardingInstruction(),
    overview: `
# Grafema Code Analysis

Grafema is a static code analyzer that builds a graph of your codebase.

## Key Tools
- query_graph: Execute Datalog queries
- find_calls: Find function/method calls
- trace_alias: Trace variable aliases
- check_invariant: Verify code invariants

## Quick Start
1. Use get_stats to see graph size
2. Use find_nodes to explore the codebase
3. Use query_graph for complex queries
`,
    queries: `
# Datalog Queries

## Syntax
violation(X) :- node(X, "TYPE"), attr(X, "name", "value").

## Available Predicates
- type(Id, Type) - match nodes (alias: node)
- edge(Src, Dst, Type) - match edges
- attr(Id, Name, Value) - match attributes
- \\+ - negation (not)

## Examples
Find all functions:
  violation(X) :- node(X, "FUNCTION").

Find unresolved calls:
  violation(X) :- node(X, "CALL"), \\+ edge(X, _, "CALLS").
`,
    types: `
# Node & Edge Types

## Core Node Types
- MODULE, FUNCTION, CLASS, METHOD, VARIABLE
- CALL, PROPERTY_ACCESS, IMPORT, EXPORT, PARAMETER

## HTTP/Network
- http:route, http:request, db:query

## Edge Types
- CONTAINS, CALLS, DEPENDS_ON
- ASSIGNED_FROM, INSTANCE_OF, PASSES_ARGUMENT
`,
    guarantees: `
# Code Guarantees

Guarantees are persistent code invariants.

## Create
Use create_guarantee with a name and Datalog rule.

## Check
Use check_guarantees to verify all guarantees.

## Example
Name: no-eval
Rule: violation(X) :- node(X, "CALL"), attr(X, "name", "eval").
`,
    notation: `
# Grafema DSL — Compact Visual Notation

Grafema DSL renders graph structure as compact, readable notation.
Output-only — Datalog remains the query language.

## Archetypes & Operators

| Archetype  | Op    | Meaning                   | Example edge types                    |
|------------|-------|---------------------------|---------------------------------------|
| contains   | (nest)| structural containment    | CONTAINS, HAS_MEMBER, DECLARES        |
| depends    | o-    | dependency / import       | DEPENDS_ON, IMPORTS_FROM, USES        |
| flow_out   | >     | outward call / data flow  | CALLS, ROUTES_TO, PASSES_ARGUMENT     |
| flow_in    | <     | inward data / type flow   | READS_FROM, ASSIGNED_FROM, EXTENDS    |
| write      | =>    | persistent side effect    | WRITES_TO, LOGS_TO                    |
| exception  | >x    | error / rejection         | THROWS, REJECTS, CATCHES_FROM         |
| publishes  | ~>>   | event / message           | EMITS_EVENT, PUBLISHES_TO, EXPOSED_VIA|
| gates      | ?|    | conditional guard         | HAS_CONDITION, HAS_CASE               |
| governs    | |=    | governance / invariant    | GOVERNS, VIOLATES, MONITORED_BY       |

## LOD Levels (depth)

- **depth=0**: Node names only — minimal overview
- **depth=1** (default): Node + edges — shows all relationships with operators
- **depth=2**: Node + edges + nested children, **folded** — repetitive siblings compressed into exemplar + summary. Ideal for large modules (e.g., 36 handler imports → 1 exemplar + fold summary)
- **depth=3**: Node + edges + nested children, **exact** — every node expanded individually, no folding. Use when you need the precise bijective DSL output

## Perspective Presets

| Preset   | Archetypes shown              | Use case                  |
|----------|-------------------------------|---------------------------|
| security | write, exception              | Audit side effects & errors|
| data     | flow_out, flow_in, write      | Trace data movement       |
| errors   | exception                     | Error handling review      |
| api      | flow_out, publishes, depends  | API surface analysis       |
| events   | publishes                     | Event flow mapping         |

## Special Modifiers

- \`??\` — uncertain/dynamic (unresolved call, dynamic import)
- \`[]\` — inside loop (edge occurs within iteration)

## Budget

Default budget: 7 items per group. When exceeded, remaining items are
summarized as \`+N more\`. Override with budget parameter.

## Usage

**MCP:** \`describe(target="src/app.ts->FUNCTION->main", depth=1, perspective="security")\`
**CLI:** \`grafema describe "src/app.ts->FUNCTION->main" -d 1 --perspective security\`

Target resolution order: semantic ID → file path (MODULE) → node name.
`,
  };

  const content = docs[topic] || docs.overview;
  return textResult(content.trim());
}
