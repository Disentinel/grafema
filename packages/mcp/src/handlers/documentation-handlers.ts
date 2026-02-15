/**
 * MCP Documentation Handlers
 */

import { getOnboardingInstruction } from '@grafema/core';
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
- node(Id, Type) - match nodes
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
  };

  const content = docs[topic] || docs.overview;
  return textResult(content.trim());
}
