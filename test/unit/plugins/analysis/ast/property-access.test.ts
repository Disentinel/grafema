/**
 * PROPERTY_ACCESS Node Tests (REG-395)
 *
 * Tests for PROPERTY_ACCESS nodes that track property reads in JavaScript/TypeScript code.
 *
 * What we're building:
 * - PROPERTY_ACCESS nodes for `obj.prop` reads (NOT method calls)
 * - One node per chain link: `a.b.c` → nodes for `b` (objectName: "a") and `c` (objectName: "a.b")
 * - Method calls (`obj.method()`) stay as CALL nodes
 * - For `a.b.c()` chain: CALL for method `c`, PROPERTY_ACCESS for `b` on `a` (intermediate links)
 * - CONTAINS edges from enclosing scope (function/module)
 *
 * Edge cases covered:
 * 1. Simple property access: `obj.prop`
 * 2. Chained property access: `a.b.c`
 * 3. `this.prop` access
 * 4. Computed properties: `obj[computed]`, `obj['literal']`, `obj[0]`
 * 5. Optional chaining: `obj?.prop`
 * 6. Property access in method call chains: `a.b.c()`
 * 7. Property access in assignments (LHS)
 * 8. Property access in function arguments
 * 9. Property access in return statements
 * 10. Property access in conditions
 * 11. Property access inside nested functions
 * 12. Property access at module level
 *
 * TDD: Tests written first per Kent Beck's methodology.
 * All tests will FAIL initially - implementation comes after.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestDatabase } from '../../../../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../../../../helpers/createTestOrchestrator.js';
import type { NodeRecord, EdgeRecord } from '@grafema/types';

let testCounter = 0;

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Helper to create a test project with given files and run analysis
 */
async function setupTest(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  files: Record<string, string>
): Promise<{ testDir: string }> {
  const testDir = join(tmpdir(), `grafema-test-prop-access-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  // package.json with main pointing to index.js
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-prop-access-${testCounter}`,
      type: 'module',
      main: 'index.js'
    })
  );

  // Create test files
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

/**
 * Get nodes by type from backend
 */
async function getNodesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  nodeType: string
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  return allNodes.filter((n: NodeRecord) => n.type === nodeType);
}

/**
 * Get all edges from backend
 */
async function getAllEdges(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend']
): Promise<EdgeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const allEdges: EdgeRecord[] = [];

  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  return allEdges;
}

/**
 * Get edges by type from backend
 */
async function getEdgesByType(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  edgeType: string
): Promise<EdgeRecord[]> {
  const allEdges = await getAllEdges(backend);
  return allEdges.filter((e: EdgeRecord) => e.type === edgeType);
}

/**
 * Find PROPERTY_ACCESS node by name and objectName
 */
async function findPropertyAccessNode(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  name: string,
  objectName?: string
): Promise<NodeRecord | undefined> {
  const allNodes = await backend.getAllNodes();
  return allNodes.find((n: NodeRecord) => {
    if (n.type !== 'PROPERTY_ACCESS') return false;
    if (n.name !== name) return false;
    if (objectName !== undefined) {
      const nodeObjectName = (n as unknown as { objectName?: string }).objectName;
      return nodeObjectName === objectName;
    }
    return true;
  });
}

/**
 * Get all PROPERTY_ACCESS nodes matching a predicate
 */
async function findAllPropertyAccessNodes(
  backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'],
  predicate?: (node: NodeRecord) => boolean
): Promise<NodeRecord[]> {
  const allNodes = await backend.getAllNodes();
  const propAccessNodes = allNodes.filter((n: NodeRecord) => n.type === 'PROPERTY_ACCESS');
  return predicate ? propAccessNodes.filter(predicate) : propAccessNodes;
}

// =============================================================================
// TESTS: PROPERTY_ACCESS Nodes (REG-395)
// =============================================================================

describe('PROPERTY_ACCESS Nodes (REG-395)', () => {
  let backend: Awaited<ReturnType<typeof createTestDatabase>>['backend'] & { cleanup: () => Promise<void> };
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(async () => {
    if (db) await db.cleanup();
  });

  // ===========================================================================
  // TEST 1: Simple property access
  // ===========================================================================

  describe('Simple property access', () => {
    it('should create PROPERTY_ACCESS node for obj.prop', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { maxBodyLength: 1000 };
const limit = config.maxBodyLength;
        `
      });

      // Find PROPERTY_ACCESS node
      const propAccessNode = await findPropertyAccessNode(backend, 'maxBodyLength', 'config');
      assert.ok(
        propAccessNode,
        'Should have PROPERTY_ACCESS node for config.maxBodyLength'
      );

      // Verify node structure
      assert.strictEqual(propAccessNode.type, 'PROPERTY_ACCESS');
      assert.strictEqual(propAccessNode.name, 'maxBodyLength');
      assert.strictEqual(
        (propAccessNode as unknown as { objectName?: string }).objectName,
        'config'
      );
    });

    it('should include file and line information', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { prop: 42 };
const x = obj.prop;
        `
      });

      const propAccessNode = await findPropertyAccessNode(backend, 'prop', 'obj');
      assert.ok(propAccessNode, 'Should have PROPERTY_ACCESS node');
      assert.ok(propAccessNode.file, 'Should have file path');
      assert.ok(propAccessNode.line, 'Should have line number');
      assert.strictEqual(propAccessNode.line, 3, 'Should be on line 3 (obj.prop access)');
    });

    it('should NOT create PROPERTY_ACCESS for method calls', async () => {
      await setupTest(backend, {
        'index.js': `
const str = "hello";
str.toUpperCase();
        `
      });

      // Should have CALL node, not PROPERTY_ACCESS
      const callNodes = await getNodesByType(backend, 'CALL');
      assert.ok(
        callNodes.some(n => (n as unknown as { method?: string }).method === 'toUpperCase'),
        'Should have CALL node for toUpperCase()'
      );

      // Should NOT have PROPERTY_ACCESS for the method name
      const propAccessNode = await findPropertyAccessNode(backend, 'toUpperCase', 'str');
      assert.ok(
        !propAccessNode,
        'Should NOT have PROPERTY_ACCESS node for method call'
      );
    });
  });

  // ===========================================================================
  // TEST 2: Chained property access
  // ===========================================================================

  describe('Chained property access', () => {
    it('should create PROPERTY_ACCESS nodes for each link in a.b.c', async () => {
      await setupTest(backend, {
        'index.js': `
const a = { b: { c: 42 } };
const value = a.b.c;
        `
      });

      // Should have two PROPERTY_ACCESS nodes: one for 'b' on 'a', one for 'c' on 'a.b'
      const propB = await findPropertyAccessNode(backend, 'b', 'a');
      const propC = await findPropertyAccessNode(backend, 'c', 'a.b');

      assert.ok(propB, 'Should have PROPERTY_ACCESS for a.b');
      assert.ok(propC, 'Should have PROPERTY_ACCESS for a.b.c');

      assert.strictEqual(propB.name, 'b');
      assert.strictEqual((propB as unknown as { objectName?: string }).objectName, 'a');

      assert.strictEqual(propC.name, 'c');
      assert.strictEqual((propC as unknown as { objectName?: string }).objectName, 'a.b');
    });

    it('should handle deeply nested chains', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { l1: { l2: { l3: { l4: 'deep' } } } };
const result = obj.l1.l2.l3.l4;
        `
      });

      // Should have 4 PROPERTY_ACCESS nodes
      const allPropAccess = await findAllPropertyAccessNodes(backend);
      assert.ok(
        allPropAccess.length >= 4,
        `Should have at least 4 PROPERTY_ACCESS nodes, got ${allPropAccess.length}`
      );

      // Verify each level
      const l1 = await findPropertyAccessNode(backend, 'l1', 'obj');
      const l2 = await findPropertyAccessNode(backend, 'l2', 'obj.l1');
      const l3 = await findPropertyAccessNode(backend, 'l3', 'obj.l1.l2');
      const l4 = await findPropertyAccessNode(backend, 'l4', 'obj.l1.l2.l3');

      assert.ok(l1, 'Should have l1');
      assert.ok(l2, 'Should have l2');
      assert.ok(l3, 'Should have l3');
      assert.ok(l4, 'Should have l4');
    });
  });

  // ===========================================================================
  // TEST 3: this.prop access
  // ===========================================================================

  describe('this.prop access', () => {
    it('should create PROPERTY_ACCESS with objectName="this"', async () => {
      await setupTest(backend, {
        'index.js': `
class Foo {
  constructor() {
    this.value = 42;
  }
  getValue() {
    return this.value;
  }
}
        `
      });

      // Should have PROPERTY_ACCESS for this.value in getValue
      const propAccessNodes = await findAllPropertyAccessNodes(
        backend,
        n => n.name === 'value'
      );

      const thisValueAccess = propAccessNodes.find(n =>
        (n as unknown as { objectName?: string }).objectName === 'this'
      );

      assert.ok(thisValueAccess, 'Should have PROPERTY_ACCESS for this.value');
      assert.strictEqual(thisValueAccess.name, 'value');
      assert.strictEqual(
        (thisValueAccess as unknown as { objectName?: string }).objectName,
        'this'
      );
    });
  });

  // ===========================================================================
  // TEST 4: Computed properties
  // ===========================================================================

  describe('Computed properties', () => {
    it('should handle obj[variable] with name="<computed>"', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { a: 1, b: 2 };
const key = 'a';
const value = obj[key];
        `
      });

      // Should have PROPERTY_ACCESS with name="<computed>"
      const propAccessNodes = await getNodesByType(backend, 'PROPERTY_ACCESS');
      const computedAccess = propAccessNodes.find(n =>
        n.name === '<computed>' &&
        (n as unknown as { objectName?: string }).objectName === 'obj'
      );

      assert.ok(
        computedAccess,
        'Should have PROPERTY_ACCESS with name="<computed>" for obj[key]'
      );
    });

    it('should handle obj["literal"] with name="literal"', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { literal: 42 };
const value = obj['literal'];
        `
      });

      // Should have PROPERTY_ACCESS with name="literal"
      const propAccessNode = await findPropertyAccessNode(backend, 'literal', 'obj');
      assert.ok(propAccessNode, 'Should have PROPERTY_ACCESS for obj["literal"]');
      assert.strictEqual(propAccessNode.name, 'literal');
    });

    it('should handle obj[0] with name="0"', async () => {
      await setupTest(backend, {
        'index.js': `
const arr = [1, 2, 3];
const first = arr[0];
        `
      });

      // Should have PROPERTY_ACCESS with name="0"
      const propAccessNode = await findPropertyAccessNode(backend, '0', 'arr');
      assert.ok(propAccessNode, 'Should have PROPERTY_ACCESS for arr[0]');
      assert.strictEqual(propAccessNode.name, '0');
    });
  });

  // ===========================================================================
  // TEST 5: Optional chaining
  // ===========================================================================

  describe('Optional chaining', () => {
    it('should handle obj?.prop with metadata.optional=true', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = null;
const value = obj?.prop;
        `
      });

      const propAccessNode = await findPropertyAccessNode(backend, 'prop', 'obj');
      assert.ok(propAccessNode, 'Should have PROPERTY_ACCESS for obj?.prop');

      // Check metadata for optional flag
      const metadata = typeof propAccessNode.metadata === 'string'
        ? JSON.parse(propAccessNode.metadata)
        : (propAccessNode.metadata || {});

      assert.ok(
        metadata.optional === true || (propAccessNode as unknown as { optional?: boolean }).optional === true,
        'Should have optional=true in metadata or as property'
      );
    });

    it('should handle chained optional access a?.b?.c', async () => {
      await setupTest(backend, {
        'index.js': `
const a = null;
const value = a?.b?.c;
        `
      });

      // Should have PROPERTY_ACCESS nodes with optional flag
      const propB = await findPropertyAccessNode(backend, 'b', 'a');
      const propC = await findPropertyAccessNode(backend, 'c', 'a.b');

      assert.ok(propB, 'Should have PROPERTY_ACCESS for a?.b');
      assert.ok(propC, 'Should have PROPERTY_ACCESS for a?.b?.c');
    });
  });

  // ===========================================================================
  // TEST 6: Property access in method call chains
  // ===========================================================================

  describe('Property access in method call chains', () => {
    it('should create PROPERTY_ACCESS for intermediate links in a.b.c()', async () => {
      await setupTest(backend, {
        'index.js': `
const a = { b: { c: () => 42 } };
a.b.c();
        `
      });

      // Should have PROPERTY_ACCESS for 'b' on 'a' (intermediate link)
      const propB = await findPropertyAccessNode(backend, 'b', 'a');
      assert.ok(propB, 'Should have PROPERTY_ACCESS for a.b (intermediate link)');

      // Should have CALL node for c(), NOT PROPERTY_ACCESS
      const callNodes = await getNodesByType(backend, 'CALL');
      const callC = callNodes.find(n =>
        (n as unknown as { method?: string }).method === 'c'
      );
      assert.ok(callC, 'Should have CALL node for c()');

      // Should NOT have PROPERTY_ACCESS for 'c' (it's the method being called)
      const propC = await findPropertyAccessNode(backend, 'c', 'a.b');
      assert.ok(
        !propC,
        'Should NOT have PROPERTY_ACCESS for c (it is the method being called)'
      );
    });

    it('should handle deeply nested method chains obj.a.b.c.d()', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { a: { b: { c: { d: () => 42 } } } };
obj.a.b.c.d();
        `
      });

      // Should have PROPERTY_ACCESS for a, b, c (intermediate links)
      const propA = await findPropertyAccessNode(backend, 'a', 'obj');
      const propB = await findPropertyAccessNode(backend, 'b', 'obj.a');
      const propC = await findPropertyAccessNode(backend, 'c', 'obj.a.b');

      assert.ok(propA, 'Should have PROPERTY_ACCESS for obj.a');
      assert.ok(propB, 'Should have PROPERTY_ACCESS for obj.a.b');
      assert.ok(propC, 'Should have PROPERTY_ACCESS for obj.a.b.c');

      // Should NOT have PROPERTY_ACCESS for 'd' (it's the method)
      const propD = await findPropertyAccessNode(backend, 'd', 'obj.a.b.c');
      assert.ok(!propD, 'Should NOT have PROPERTY_ACCESS for d (method call)');
    });
  });

  // ===========================================================================
  // TEST 7: Property access in assignments (LHS)
  // ===========================================================================

  describe('Property access in assignments', () => {
    it('should skip PROPERTY_ACCESS for assignment LHS (write operation)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {};
obj.prop = 42;
        `
      });

      // Assignment LHS is a WRITE, not a READ - should be handled by mutation tracking
      // Should NOT create PROPERTY_ACCESS for obj.prop on LHS
      const propAccessNodes = await findAllPropertyAccessNodes(backend);
      const lhsAccess = propAccessNodes.find(n =>
        n.name === 'prop' &&
        (n as unknown as { objectName?: string }).objectName === 'obj'
      );

      assert.ok(
        !lhsAccess,
        'Should NOT have PROPERTY_ACCESS for assignment LHS (write operation)'
      );
    });

    it('should create PROPERTY_ACCESS for assignment RHS (read operation)', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { source: 42 };
const target = {};
target.dest = obj.source;
        `
      });

      // RHS is a READ - should have PROPERTY_ACCESS
      const rhsAccess = await findPropertyAccessNode(backend, 'source', 'obj');
      assert.ok(rhsAccess, 'Should have PROPERTY_ACCESS for obj.source (RHS read)');
    });
  });

  // ===========================================================================
  // TEST 8: Property access in function arguments
  // ===========================================================================

  describe('Property access in function arguments', () => {
    it('should create PROPERTY_ACCESS for property access in arguments', async () => {
      await setupTest(backend, {
        'index.js': `
function process(value) {
  return value;
}
const config = { maxBodyLength: 1000 };
process(config.maxBodyLength);
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'maxBodyLength', 'config');
      assert.ok(
        propAccess,
        'Should have PROPERTY_ACCESS for config.maxBodyLength in function argument'
      );
    });

    it('should handle chained property access in arguments', async () => {
      await setupTest(backend, {
        'index.js': `
function log(msg) {
  console.log(msg);
}
const app = { config: { logger: { level: 'debug' } } };
log(app.config.logger.level);
        `
      });

      // Should have PROPERTY_ACCESS nodes for config, logger, level
      const propConfig = await findPropertyAccessNode(backend, 'config', 'app');
      const propLogger = await findPropertyAccessNode(backend, 'logger', 'app.config');
      const propLevel = await findPropertyAccessNode(backend, 'level', 'app.config.logger');

      assert.ok(propConfig, 'Should have PROPERTY_ACCESS for app.config');
      assert.ok(propLogger, 'Should have PROPERTY_ACCESS for app.config.logger');
      assert.ok(propLevel, 'Should have PROPERTY_ACCESS for app.config.logger.level');
    });
  });

  // ===========================================================================
  // TEST 9: Property access in return statements
  // ===========================================================================

  describe('Property access in return statements', () => {
    it('should create PROPERTY_ACCESS for property access in return', async () => {
      await setupTest(backend, {
        'index.js': `
function getLimit(config) {
  return config.maxBodyLength;
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'maxBodyLength', 'config');
      assert.ok(
        propAccess,
        'Should have PROPERTY_ACCESS for config.maxBodyLength in return statement'
      );

      // Verify it's inside the function scope
      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const getLimitFn = functionNodes.find(n => n.name === 'getLimit');
      assert.ok(getLimitFn, 'Should have getLimit function');

      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const fnContainsProp = containsEdges.find(e =>
        e.src === getLimitFn!.id && e.dst === propAccess.id
      );

      assert.ok(
        fnContainsProp,
        'Function should CONTAIN the PROPERTY_ACCESS node'
      );
    });
  });

  // ===========================================================================
  // TEST 10: Property access in conditions
  // ===========================================================================

  describe('Property access in conditions', () => {
    it('should create PROPERTY_ACCESS for property access in if condition', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { maxBodyLength: 1000 };
if (config.maxBodyLength > 0) {
  console.log('valid');
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'maxBodyLength', 'config');
      assert.ok(
        propAccess,
        'Should have PROPERTY_ACCESS for config.maxBodyLength in if condition'
      );
    });

    it('should create PROPERTY_ACCESS for property access in while condition', async () => {
      await setupTest(backend, {
        'index.js': `
const state = { running: true };
while (state.running) {
  break;
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'running', 'state');
      assert.ok(
        propAccess,
        'Should have PROPERTY_ACCESS for state.running in while condition'
      );
    });

    it('should create PROPERTY_ACCESS for property access in ternary', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { debug: true };
const mode = config.debug ? 'dev' : 'prod';
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'debug', 'config');
      assert.ok(
        propAccess,
        'Should have PROPERTY_ACCESS for config.debug in ternary'
      );
    });
  });

  // ===========================================================================
  // TEST 11: Property access inside nested functions
  // ===========================================================================

  describe('Property access inside nested functions', () => {
    it('should create PROPERTY_ACCESS inside nested function scope', async () => {
      await setupTest(backend, {
        'index.js': `
function outer(config) {
  function inner() {
    return config.maxBodyLength;
  }
  return inner();
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'maxBodyLength', 'config');
      assert.ok(
        propAccess,
        'Should have PROPERTY_ACCESS inside nested function'
      );

      // Verify it's inside the inner function scope
      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const innerFn = functionNodes.find(n => n.name === 'inner');
      assert.ok(innerFn, 'Should have inner function');

      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const innerContainsProp = containsEdges.find(e =>
        e.src === innerFn!.id && e.dst === propAccess.id
      );

      assert.ok(
        innerContainsProp,
        'Inner function should CONTAIN the PROPERTY_ACCESS node'
      );
    });

    it('should create PROPERTY_ACCESS inside arrow function', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { timeout: 5000 };
const getTimeout = () => config.timeout;
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'timeout', 'config');
      assert.ok(
        propAccess,
        'Should have PROPERTY_ACCESS inside arrow function'
      );
    });
  });

  // ===========================================================================
  // TEST 12: Property access at module level
  // ===========================================================================

  describe('Property access at module level', () => {
    it('should create PROPERTY_ACCESS at module level', async () => {
      await setupTest(backend, {
        'index.js': `
const config = { port: 3000 };
config.port;
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'port', 'config');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS at module level');

      // Verify CONTAINS edge from MODULE
      const moduleNodes = await getNodesByType(backend, 'MODULE');
      assert.ok(moduleNodes.length > 0, 'Should have MODULE node');

      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const moduleContainsProp = containsEdges.find(e =>
        e.src === moduleNodes[0].id && e.dst === propAccess.id
      );

      assert.ok(
        moduleContainsProp,
        'MODULE should CONTAIN the PROPERTY_ACCESS node'
      );
    });
  });

  // ===========================================================================
  // TEST 13: CONTAINS edges
  // ===========================================================================

  describe('CONTAINS edges for PROPERTY_ACCESS', () => {
    it('should create CONTAINS edge from enclosing scope', async () => {
      await setupTest(backend, {
        'index.js': `
function process(config) {
  return config.maxBodyLength;
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'maxBodyLength', 'config');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS node');

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const processFn = functionNodes.find(n => n.name === 'process');
      assert.ok(processFn, 'Should have process function');

      const containsEdges = await getEdgesByType(backend, 'CONTAINS');
      const fnContainsProp = containsEdges.find(e =>
        e.src === processFn!.id && e.dst === propAccess.id
      );

      assert.ok(
        fnContainsProp,
        'Should have CONTAINS edge from FUNCTION to PROPERTY_ACCESS'
      );
    });

    it('should create multiple CONTAINS edges for multiple property accesses', async () => {
      await setupTest(backend, {
        'index.js': `
function init(config) {
  const port = config.port;
  const host = config.host;
  return { port, host };
}
        `
      });

      const propPort = await findPropertyAccessNode(backend, 'port', 'config');
      const propHost = await findPropertyAccessNode(backend, 'host', 'config');

      assert.ok(propPort, 'Should have PROPERTY_ACCESS for port');
      assert.ok(propHost, 'Should have PROPERTY_ACCESS for host');

      const functionNodes = await getNodesByType(backend, 'FUNCTION');
      const initFn = functionNodes.find(n => n.name === 'init');
      assert.ok(initFn, 'Should have init function');

      const containsEdges = await getEdgesByType(backend, 'CONTAINS');

      const fnContainsPort = containsEdges.find(e =>
        e.src === initFn!.id && e.dst === propPort.id
      );
      const fnContainsHost = containsEdges.find(e =>
        e.src === initFn!.id && e.dst === propHost.id
      );

      assert.ok(fnContainsPort, 'Should have CONTAINS edge for port access');
      assert.ok(fnContainsHost, 'Should have CONTAINS edge for host access');
    });
  });

  // ===========================================================================
  // TEST 14: Semantic IDs
  // ===========================================================================

  describe('Semantic IDs for PROPERTY_ACCESS', () => {
    it('should have semanticId field', async () => {
      await setupTest(backend, {
        'index.js': `
function process(config) {
  return config.maxBodyLength;
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'maxBodyLength', 'config');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS node');

      // Check for semanticId field
      const semanticId = (propAccess as unknown as { semanticId?: string }).semanticId;
      assert.ok(
        semanticId,
        'PROPERTY_ACCESS node should have semanticId field'
      );
    });
  });

  // ===========================================================================
  // TEST 15: No duplication with CALL nodes
  // ===========================================================================

  describe('No duplication with CALL nodes', () => {
    it('should not create duplicate nodes for method calls', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = { method: () => 42 };
obj.method();
        `
      });

      // Should have CALL node for method()
      const callNodes = await getNodesByType(backend, 'CALL');
      const methodCall = callNodes.find(n =>
        (n as unknown as { method?: string }).method === 'method' &&
        (n as unknown as { object?: string }).object === 'obj'
      );
      assert.ok(methodCall, 'Should have CALL node for obj.method()');

      // Should NOT have PROPERTY_ACCESS for 'method' (it's the call target)
      const propAccess = await findPropertyAccessNode(backend, 'method', 'obj');
      assert.ok(
        !propAccess,
        'Should NOT have PROPERTY_ACCESS for method name in obj.method()'
      );
    });

    it('should distinguish between read and call: obj.prop vs obj.method()', async () => {
      await setupTest(backend, {
        'index.js': `
const obj = {
  prop: 42,
  method: () => 42
};
const value = obj.prop;
obj.method();
        `
      });

      // Should have PROPERTY_ACCESS for obj.prop (read)
      const propAccess = await findPropertyAccessNode(backend, 'prop', 'obj');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS for obj.prop (read)');

      // Should have CALL for obj.method() (call)
      const callNodes = await getNodesByType(backend, 'CALL');
      const methodCall = callNodes.find(n =>
        (n as unknown as { method?: string }).method === 'method'
      );
      assert.ok(methodCall, 'Should have CALL node for obj.method() (call)');

      // Should NOT have PROPERTY_ACCESS for 'method'
      const methodPropAccess = await findPropertyAccessNode(backend, 'method', 'obj');
      assert.ok(
        !methodPropAccess,
        'Should NOT have PROPERTY_ACCESS for method (it is called)'
      );
    });
  });

  // ===========================================================================
  // TEST: import.meta property access (REG-300)
  // ===========================================================================

  describe('import.meta property access (REG-300)', () => {
    it('should create PROPERTY_ACCESS node for import.meta.url', async () => {
      await setupTest(backend, {
        'index.js': `
const __filename = import.meta.url;
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'url', 'import.meta');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS for import.meta.url');
      assert.strictEqual(propAccess!.name, 'url');
      assert.strictEqual(
        (propAccess as unknown as { objectName: string }).objectName,
        'import.meta'
      );
    });

    it('should create PROPERTY_ACCESS nodes for import.meta.env.MODE (chained)', async () => {
      await setupTest(backend, {
        'index.js': `
const mode = import.meta.env.MODE;
        `
      });

      // First link: import.meta.env
      const envAccess = await findPropertyAccessNode(backend, 'env', 'import.meta');
      assert.ok(envAccess, 'Should have PROPERTY_ACCESS for import.meta.env');

      // Second link: import.meta.env.MODE
      const modeAccess = await findPropertyAccessNode(backend, 'MODE', 'import.meta.env');
      assert.ok(modeAccess, 'Should have PROPERTY_ACCESS for import.meta.env.MODE');
    });

    it('should create PROPERTY_ACCESS for import.meta.resolve() intermediate links', async () => {
      await setupTest(backend, {
        'index.js': `
const resolved = import.meta.resolve('./module.js');
        `
      });

      // import.meta.resolve() — 'resolve' is a call target, so no PROPERTY_ACCESS for it
      // But there should be a CALL node for it
      const callNodes = await getNodesByType(backend, 'CALL');
      const resolveCall = callNodes.find(n =>
        (n as unknown as { method?: string }).method === 'resolve'
      );
      assert.ok(resolveCall, 'Should have CALL node for import.meta.resolve()');

      // No PROPERTY_ACCESS for 'resolve' since it's a call target
      const resolvePropAccess = await findPropertyAccessNode(backend, 'resolve', 'import.meta');
      assert.ok(!resolvePropAccess, 'Should NOT have PROPERTY_ACCESS for resolve (it is called)');
    });

    it('should store import.meta properties on MODULE node', async () => {
      await setupTest(backend, {
        'index.js': `
const u = import.meta.url;
const e = import.meta.env;
        `
      });

      const moduleNodes = await getNodesByType(backend, 'MODULE');
      const mod = moduleNodes.find(n => n.name?.endsWith('index.js'));
      assert.ok(mod, 'Should have MODULE node');

      // importMeta is at top level (backend spreads metadata fields)
      const importMeta = (mod as unknown as { importMeta?: string[] }).importMeta;
      assert.ok(importMeta, 'MODULE should have importMeta');
      assert.ok(importMeta!.includes('url'), 'importMeta should include "url"');
      assert.ok(importMeta!.includes('env'), 'importMeta should include "env"');
    });

    it('should handle multiple import.meta.url accesses without duplicating metadata', async () => {
      await setupTest(backend, {
        'index.js': `
const a = import.meta.url;
const b = import.meta.url;
        `
      });

      const moduleNodes = await getNodesByType(backend, 'MODULE');
      const mod = moduleNodes.find(n => n.name?.endsWith('index.js'));
      const importMeta = (mod as unknown as { importMeta?: string[] }).importMeta;
      assert.ok(importMeta, 'MODULE should have importMeta');
      // Should be deduplicated
      const urlCount = importMeta!.filter(p => p === 'url').length;
      assert.strictEqual(urlCount, 1, 'importMeta should deduplicate "url"');
    });

    it('should track import.meta inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function getDir() {
  return import.meta.url;
}
        `
      });

      const propAccess = await findPropertyAccessNode(backend, 'url', 'import.meta');
      assert.ok(propAccess, 'Should have PROPERTY_ACCESS for import.meta.url inside function');
    });
  });
});
