#!/usr/bin/env node
/**
 * Axum Route Detector — Grafema batch plugin
 *
 * Detects Axum .route("/path", get(handler)) calls in Rust files
 * and creates http:route nodes with path and handler edges.
 *
 * Runs AFTER analysis, BEFORE semantic-bridge-detector.
 *
 * Environment:
 *   RFDB_SOCKET  — path to RFDB unix socket
 *   RFDB_DATABASE — database name
 */

import { RFDBClient } from '../packages/rfdb/dist/client.js';

const socketPath = process.env.RFDB_SOCKET;
const dbName = process.env.RFDB_DATABASE;

if (!socketPath) {
  console.error('[axum-routes] RFDB_SOCKET not set');
  process.exit(1);
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

const client = new RFDBClient(socketPath, 'axum-route-detector');

try {
  await client.connect();
  if (dbName) await client.openDatabase(dbName);

  const routeNodes = [];
  const routeEdges = [];

  // Find all CALL nodes named "route" in Rust files
  for await (const call of client.queryNodes({ type: 'CALL', name: 'route' })) {
    const file = call.file || '';
    if (!file.endsWith('.rs')) continue;

    const callId = String(call.id);
    const outEdges = await client.getOutgoingEdges(callId);
    const args = outEdges
      .filter(e => e.type === 'PASSES_ARGUMENT')
      .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));

    if (args.length < 2) continue;

    // Arg 0: route path (string literal)
    const pathNode = await client.getNode(args[0].dst);
    if (!pathNode || (pathNode.nodeType || pathNode.type) !== 'LITERAL') continue;
    const routePath = pathNode.name || '';
    if (!routePath.startsWith('/')) continue;

    // Arg 1: HTTP method wrapper — get(handler), post(handler)
    const methodCall = await client.getNode(args[1].dst);
    let httpMethod = 'GET';
    let handlerId = null;

    if (methodCall && (methodCall.nodeType || methodCall.type) === 'CALL') {
      const methodName = (methodCall.name || '').toLowerCase();
      if (HTTP_METHODS.has(methodName)) {
        httpMethod = methodName.toUpperCase();
      }
      // The handler is the first argument of get(handler)
      const methodEdges = await client.getOutgoingEdges(String(methodCall.id));
      const handlerArg = methodEdges
        .filter(e => e.type === 'PASSES_ARGUMENT')
        .sort((a, b) => (a.index ?? 999) - (b.index ?? 999))[0];
      if (handlerArg) {
        handlerId = handlerArg.dst;
      }
    }

    // Create http:route node
    const routeId = `http:route:${httpMethod}:${routePath}@${file}`;
    routeNodes.push({
      id: routeId,
      type: 'http:route',
      name: `${httpMethod} ${routePath}`,
      file,
      line: call.line || 0,
      exported: true,
      metadata: JSON.stringify({
        _source: 'axum-route-detector',
        method: httpMethod,
        path: routePath,
        framework: 'axum',
      }),
    });

    // EXPOSES edge: CALL(route) → http:route
    routeEdges.push({
      src: callId,
      dst: routeId,
      type: 'EXPOSES',
      metadata: JSON.stringify({ _source: 'axum-route-detector' }),
    });

    // HANDLES edge: http:route → handler function (if resolved)
    if (handlerId) {
      routeEdges.push({
        src: routeId,
        dst: handlerId,
        type: 'HANDLES',
        metadata: JSON.stringify({ _source: 'axum-route-detector' }),
      });
    }
  }

  if (routeNodes.length > 0) {
    await client.addNodes(routeNodes);
    await client.addEdges(routeEdges);
  }

  console.error(`[axum-routes] Done: ${routeNodes.length} http:route nodes created`);
  for (const n of routeNodes) {
    const meta = JSON.parse(n.metadata);
    console.error(`  ${meta.method} ${meta.path}`);
  }

  await client.close();
} catch (err) {
  console.error(`[axum-routes] Error: ${err.message}`);
  await client.close();
  process.exit(1);
}
