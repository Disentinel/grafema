/**
 * GraphQL query handler — execute GraphQL queries against the code graph.
 *
 * Uses @grafema/api's schema and resolvers in-process via graphql-yoga.
 * No HTTP server needed — yoga.fetch() accepts synthetic Request objects.
 */

import { ensureAnalyzed } from '../analysis.js';
import { textResult, errorResult } from '../utils.js';
import type { ToolResult, GraphQLQueryArgs } from '../types.js';
import type { RFDBServerBackend } from '@grafema/util';

let yogaInstance: any = null;
let yogaBackend: RFDBServerBackend | null = null;

/**
 * Get or create the yoga instance.
 * Recreated if the backend changes (e.g., after re-analysis).
 */
async function getYoga(backend: RFDBServerBackend) {
  if (yogaInstance && yogaBackend === backend) {
    return yogaInstance;
  }

  // Dynamic import to avoid loading graphql-yoga unless needed
  const { createGraphQLServer } = await import('@grafema/api');
  yogaInstance = createGraphQLServer({ backend });
  yogaBackend = backend;
  return yogaInstance;
}

export async function handleGraphQLQuery(args: GraphQLQueryArgs): Promise<ToolResult> {
  const { query, variables, operationName } = args;

  if (!query || query.trim() === '') {
    return errorResult('query must be a non-empty GraphQL query string');
  }

  const db = await ensureAnalyzed();
  const yoga = await getYoga(db as RFDBServerBackend);

  // Build the GraphQL request body
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  if (operationName) body.operationName = operationName;

  // Execute via yoga.fetch() — no HTTP server needed
  const response = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const result = await response.json();

  // Format output
  if (result.errors && result.errors.length > 0) {
    const errorMessages = result.errors.map((e: any) => e.message).join('\n');
    if (result.data) {
      // Partial success — return data with errors noted
      return textResult(
        `GraphQL partial result (with errors):\n${errorMessages}\n\n` +
        JSON.stringify(result.data, null, 2)
      );
    }
    return errorResult(`GraphQL errors:\n${errorMessages}`);
  }

  return textResult(JSON.stringify(result.data, null, 2));
}
