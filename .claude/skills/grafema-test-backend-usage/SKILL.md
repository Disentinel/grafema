---
name: grafema-test-backend-usage
description: |
  Fix node query issues in Grafema tests when nodes have numeric IDs instead of
  human-readable IDs, or when `type` field is undefined. Use when: (1) queryNodes
  returns nodes with numeric IDs like "52710336597754872375318185843222727675"
  instead of semantic IDs like "net:request#__network__", (2) node.type is undefined
  but node.nodeType has a value, (3) metadata is a JSON string instead of parsed object,
  (4) tests fail with "Cannot read property 'length' of undefined" after queryNodes.
  Covers RFDBServerBackend vs RFDBClient distinction and async generator handling.
author: Claude Code
version: 1.0.0
date: 2025-01-22
---

# Grafema Test Backend Usage

## Problem

Tests querying the graph return malformed node data:
- IDs are internal numeric strings instead of human-readable semantic IDs
- `type` field is undefined (only `nodeType` is set)
- `metadata` is a raw JSON string instead of parsed object
- `originalId` and other metadata fields are missing from node

## Context / Trigger Conditions

1. Test uses `backend.client` to query nodes:
   ```javascript
   const graph = backend.client;  // WRONG
   const nodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));
   ```

2. Node ID is numeric instead of semantic:
   ```
   Expected: "net:request#__network__"
   Actual: "52710336597754872375318185843222727675"
   ```

3. `node.type` is undefined but `node.nodeType` has the correct value

4. Using `await graph.queryNodes()` expecting an array (it's an async generator)

## Solution

### Issue 1: Use `backend` directly, not `backend.client`

```javascript
// WRONG - returns unparsed wire format
const graph = backend.client;

// CORRECT - returns parsed nodes with human-readable IDs
const graph = backend;
```

**Why**: `backend` is `RFDBServerBackend` which has `_parseNode()` that:
- Extracts `originalId` from metadata and uses it as the node's `id`
- Sets both `type` and `nodeType` from wire format
- Parses and spreads metadata fields onto the node object

`backend.client` is the raw `RFDBClient` which returns the wire format without parsing.

### Issue 2: Handle async generator properly

```javascript
// WRONG - queryNodes returns async generator, not Promise<array>
const nodes = await graph.queryNodes({ type: 'net:request' });
nodes.length;  // undefined - nodes is an async generator

// CORRECT - collect results into array
async function collectNodes(asyncGen) {
  const results = [];
  for await (const node of asyncGen) {
    results.push(node);
  }
  return results;
}

const nodes = await collectNodes(graph.queryNodes({ type: 'net:request' }));
nodes.length;  // works correctly
```

### Issue 3: Use correct edge query methods

```javascript
// WRONG - queryEdges doesn't exist
const edges = await graph.queryEdges({ type: 'CALLS', src: nodeId });

// CORRECT - use getOutgoingEdges or getIncomingEdges
const edges = await graph.getOutgoingEdges(nodeId, ['CALLS']);
```

## Verification

After fixing, verify nodes have correct structure:

```javascript
for await (const node of backend.queryNodes({ type: 'net:request' })) {
  console.log('ID:', node.id);           // Should be "net:request#__network__"
  console.log('type:', node.type);       // Should be "net:request"
  console.log('nodeType:', node.nodeType); // Should be "net:request"
  console.log('originalId:', node.originalId); // Should match id
}
```

## Example

Full test pattern:

```javascript
import { createTestBackend } from '../helpers/TestRFDB.js';

describe('My Test', () => {
  let backend;

  beforeEach(async () => {
    backend = createTestBackend();
    await backend.connect();  // Don't forget this!
  });

  afterEach(async () => {
    if (backend) await backend.close();
  });

  it('should find nodes correctly', async () => {
    // ... setup and analysis ...

    // Use backend directly, not backend.client
    const graph = backend;

    // Collect async generator results
    const nodes = [];
    for await (const node of graph.queryNodes({ type: 'net:request' })) {
      nodes.push(node);
    }

    // Now nodes is an array with properly parsed nodes
    assert.strictEqual(nodes[0].id, 'net:request#__network__');
    assert.strictEqual(nodes[0].type, 'net:request');
  });
});
```

## Notes

- `RFDBServerBackend._parseNode()` is responsible for the transformation
- The `originalId` is stored in the node's `metadata` JSON field in the database
- Both `type` and `nodeType` are set to the same value after parsing
- Edge methods (`getOutgoingEdges`, `getIncomingEdges`) return arrays, not generators
- Always call `backend.connect()` in `beforeEach` - the backend is not auto-connected
