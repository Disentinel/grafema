/**
 * Unit tests for REG-230: Sink-based trace functionality
 *
 * Tests `grafema trace --to "fn#0.property"` functionality.
 * This enables answering "what values can reach this sink point?"
 *
 * Linus requirements:
 * 1. Property path should be OPTIONAL (`fn#0` should work, traces entire argument)
 * 2. Implement inline in trace.ts (not separate file)
 * 3. Handle both direct calls (`fn()`) and method calls (`obj.fn()`)
 * 4. Use existing ValueDomainAnalyzer.getValueSet()
 *
 * TDD: These tests define expected behavior BEFORE implementation.
 */

import { describe, it, beforeEach, afterEach, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { TestBackend } from '../../helpers/TestRFDB.js';

// Cache for loaded module
let traceModule = null;

/**
 * Load the trace module (ESM)
 */
async function loadTraceModule() {
  if (traceModule) return traceModule;
  try {
    traceModule = await import('../../../packages/cli/dist/commands/trace.js');
    return traceModule;
  } catch (e) {
    console.error('Failed to load trace module:', e.message);
    return null;
  }
}

/**
 * ============================================================================
 * PART 1: SINK SPEC PARSING
 * ============================================================================
 * Tests for parseSinkSpec() function.
 * Expected behavior:
 *   - Parse "functionName#argIndex.property.path" format
 *   - Property path is OPTIONAL
 *   - Return structured SinkSpec object
 */

describe('REG-230: Sink Spec Parsing', () => {
  before(async () => {
    await loadTraceModule();
  });

  describe('valid sink specs', () => {
    it('should parse "fn#0.type" as valid sink spec', () => {
      // Expected: {functionName: "fn", argIndex: 0, propertyPath: ["type"]}
      // This test will fail until parseSinkSpec is implemented
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      const result = parseSinkSpec('fn#0.type');

      assert.strictEqual(result.functionName, 'fn');
      assert.strictEqual(result.argIndex, 0);
      assert.deepStrictEqual(result.propertyPath, ['type']);
      assert.strictEqual(result.raw, 'fn#0.type');
    });

    it('should parse "addNode#0.config.options" with multi-level property path', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      const result = parseSinkSpec('addNode#0.config.options');

      assert.strictEqual(result.functionName, 'addNode');
      assert.strictEqual(result.argIndex, 0);
      assert.deepStrictEqual(result.propertyPath, ['config', 'options']);
      assert.strictEqual(result.raw, 'addNode#0.config.options');
    });

    it('should parse "fn#0" with no property path (traces entire argument)', () => {
      // Linus requirement: property path should be optional
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      const result = parseSinkSpec('fn#0');

      assert.strictEqual(result.functionName, 'fn');
      assert.strictEqual(result.argIndex, 0);
      assert.deepStrictEqual(result.propertyPath, []);
      assert.strictEqual(result.raw, 'fn#0');
    });

    it('should parse "fn#5.value" with higher argument index', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      const result = parseSinkSpec('fn#5.value');

      assert.strictEqual(result.functionName, 'fn');
      assert.strictEqual(result.argIndex, 5);
      assert.deepStrictEqual(result.propertyPath, ['value']);
    });

    it('should parse function names with underscores and numbers', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      const result = parseSinkSpec('add_node_v2#1.type');

      assert.strictEqual(result.functionName, 'add_node_v2');
      assert.strictEqual(result.argIndex, 1);
      assert.deepStrictEqual(result.propertyPath, ['type']);
    });
  });

  describe('invalid sink specs', () => {
    it('should reject "#0.type" (no function name)', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        parseSinkSpec('#0.type');
      }, /function name|invalid/i);
    });

    it('should reject "fn#abc.type" (argIndex not numeric)', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        parseSinkSpec('fn#abc.type');
      }, /argument index|numeric|invalid/i);
    });

    it('should reject "fn" (no # separator)', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        parseSinkSpec('fn');
      }, /#|separator|invalid/i);
    });

    it('should reject "fn#-1.type" (negative argIndex)', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        parseSinkSpec('fn#-1.type');
      }, /negative|argument index|invalid/i);
    });

    it('should reject empty string', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        parseSinkSpec('');
      }, /invalid|empty/i);
    });

    it('should reject "fn#.type" (missing argIndex)', () => {
      const parseSinkSpec = getSinkSpecParser();
      if (!parseSinkSpec) {
        throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
      }

      assert.throws(() => {
        parseSinkSpec('fn#.type');
      }, /argument index|invalid/i);
    });
  });
});

/**
 * ============================================================================
 * PART 2: SINK RESOLUTION (Integration Tests)
 * ============================================================================
 * Tests for resolveSink() functionality using TestBackend.
 * These tests create realistic graph structures and verify sink resolution.
 */

describe('REG-230: Sink Resolution', () => {
  let backend;

  before(async () => {
    await loadTraceModule();
  });

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
  });

  afterEach(async () => {
    if (backend) {
      await backend.cleanup();
    }
  });

  describe('call site discovery', () => {
    it('should find call sites for direct function calls', async () => {
      // Setup: Create addNode function call
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->addNode#0',
          nodeType: 'CALL',
          name: 'addNode',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->CALL->addNode#1',
          nodeType: 'CALL',
          name: 'addNode',
          file: 'test.js',
          line: 20,
        },
      ]);
      await backend.flush();

      // Test: findCallSites should find both calls
      const findCallSites = getCallSiteFinder();
      if (!findCallSites) {
        throw new Error('findCallSites not implemented yet (expected for TDD)');
      }

      const callSites = await findCallSites(backend, 'addNode');

      assert.strictEqual(callSites.length, 2, 'Should find 2 call sites');
      assert.ok(callSites.every(cs => cs.calleeFunction === 'addNode'));
    });

    it('should find call sites for method calls (obj.addNode())', async () => {
      // Linus requirement: handle both direct calls and method calls
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->graph.addNode#0',
          nodeType: 'CALL',
          name: 'graph.addNode',
          method: 'addNode',
          object: 'graph',
          file: 'test.js',
          line: 15,
        },
      ]);
      await backend.flush();

      const findCallSites = getCallSiteFinder();
      if (!findCallSites) {
        throw new Error('findCallSites not implemented yet (expected for TDD)');
      }

      const callSites = await findCallSites(backend, 'addNode');

      assert.strictEqual(callSites.length, 1, 'Should find method call');
      assert.strictEqual(callSites[0].calleeFunction, 'addNode');
    });

    it('should return empty array when function not found', async () => {
      // No nodes in graph
      await backend.flush();

      const findCallSites = getCallSiteFinder();
      if (!findCallSites) {
        throw new Error('findCallSites not implemented yet (expected for TDD)');
      }

      const callSites = await findCallSites(backend, 'nonexistent');

      assert.strictEqual(callSites.length, 0, 'Should return empty array');
    });
  });

  describe('argument extraction', () => {
    it('should extract argument at specified index via PASSES_ARGUMENT edge', async () => {
      // Setup: CALL -> PASSES_ARGUMENT -> VARIABLE
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->addNode#0',
          nodeType: 'CALL',
          name: 'addNode',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->VARIABLE->config',
          nodeType: 'VARIABLE',
          name: 'config',
          file: 'test.js',
          line: 5,
        },
      ]);

      await backend.addEdge({
        src: 'test.js->global->CALL->addNode#0',
        dst: 'test.js->global->VARIABLE->config',
        edgeType: 'PASSES_ARGUMENT',
        argIndex: 0,
      });
      await backend.flush();

      // Test: extractArgument should return the variable node
      const extractArgument = getArgumentExtractor();
      if (!extractArgument) {
        throw new Error('extractArgument not implemented yet (expected for TDD)');
      }

      const argNodeId = await extractArgument(backend, 'test.js->global->CALL->addNode#0', 0);

      assert.strictEqual(argNodeId, 'test.js->global->VARIABLE->config');
    });

    it('should return null when argument index out of range', async () => {
      // Setup: Call with only 1 argument (index 0)
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->fn#0',
          nodeType: 'CALL',
          name: 'fn',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->VARIABLE->arg0',
          nodeType: 'VARIABLE',
          name: 'arg0',
          file: 'test.js',
          line: 5,
        },
      ]);

      await backend.addEdge({
        src: 'test.js->global->CALL->fn#0',
        dst: 'test.js->global->VARIABLE->arg0',
        edgeType: 'PASSES_ARGUMENT',
        argIndex: 0,
      });
      await backend.flush();

      const extractArgument = getArgumentExtractor();
      if (!extractArgument) {
        throw new Error('extractArgument not implemented yet (expected for TDD)');
      }

      // Try to get argument at index 5 (doesn't exist)
      const argNodeId = await extractArgument(backend, 'test.js->global->CALL->fn#0', 5);

      assert.strictEqual(argNodeId, null, 'Should return null for out-of-range index');
    });
  });

  describe('value tracing through objects', () => {
    it('should trace property "type" to LITERAL values', async () => {
      // Setup:
      //   config = { type: "FUNCTION" }
      //   addNode(config)
      //
      // Graph:
      //   VARIABLE->config -> ASSIGNED_FROM -> OBJECT_LITERAL
      //   OBJECT_LITERAL -> HAS_PROPERTY -> LITERAL("FUNCTION")
      //   CALL->addNode -> PASSES_ARGUMENT -> VARIABLE->config

      await backend.addNodes([
        {
          id: 'test.js->global->CALL->addNode#0',
          nodeType: 'CALL',
          name: 'addNode',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->VARIABLE->config',
          nodeType: 'VARIABLE',
          name: 'config',
          file: 'test.js',
          line: 5,
        },
        {
          id: 'test.js->global->OBJECT_LITERAL#0',
          nodeType: 'OBJECT_LITERAL',
          file: 'test.js',
          line: 5,
        },
        {
          id: 'test.js->global->LITERAL->FUNCTION',
          nodeType: 'LITERAL',
          value: 'FUNCTION',
          valueType: 'string',
          file: 'test.js',
          line: 5,
        },
      ]);

      await backend.addEdges([
        {
          src: 'test.js->global->CALL->addNode#0',
          dst: 'test.js->global->VARIABLE->config',
          edgeType: 'PASSES_ARGUMENT',
          argIndex: 0,
        },
        {
          src: 'test.js->global->VARIABLE->config',
          dst: 'test.js->global->OBJECT_LITERAL#0',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->OBJECT_LITERAL#0',
          dst: 'test.js->global->LITERAL->FUNCTION',
          edgeType: 'HAS_PROPERTY',
          propertyName: 'type',
        },
      ]);
      await backend.flush();

      // Test: resolveSink should find LITERAL value "FUNCTION"
      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'addNode',
        argIndex: 0,
        propertyPath: ['type'],
        raw: 'addNode#0.type',
      });

      assert.strictEqual(result.statistics.callSites, 1, 'Should find 1 call site');
      assert.strictEqual(result.possibleValues.length, 1, 'Should find 1 value');
      assert.strictEqual(result.possibleValues[0].value, 'FUNCTION');
    });

    it('should find multiple values from different call sites', async () => {
      // Setup:
      //   config1 = { type: "FUNCTION" }
      //   config2 = { type: "CLASS" }
      //   addNode(config1);
      //   addNode(config2);

      await backend.addNodes([
        // First call site
        {
          id: 'test.js->global->CALL->addNode#0',
          nodeType: 'CALL',
          name: 'addNode',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->VARIABLE->config1',
          nodeType: 'VARIABLE',
          name: 'config1',
          file: 'test.js',
          line: 3,
        },
        {
          id: 'test.js->global->OBJECT_LITERAL#0',
          nodeType: 'OBJECT_LITERAL',
          file: 'test.js',
          line: 3,
        },
        {
          id: 'test.js->global->LITERAL->FUNCTION',
          nodeType: 'LITERAL',
          value: 'FUNCTION',
          valueType: 'string',
          file: 'test.js',
          line: 3,
        },
        // Second call site
        {
          id: 'test.js->global->CALL->addNode#1',
          nodeType: 'CALL',
          name: 'addNode',
          file: 'test.js',
          line: 15,
        },
        {
          id: 'test.js->global->VARIABLE->config2',
          nodeType: 'VARIABLE',
          name: 'config2',
          file: 'test.js',
          line: 4,
        },
        {
          id: 'test.js->global->OBJECT_LITERAL#1',
          nodeType: 'OBJECT_LITERAL',
          file: 'test.js',
          line: 4,
        },
        {
          id: 'test.js->global->LITERAL->CLASS',
          nodeType: 'LITERAL',
          value: 'CLASS',
          valueType: 'string',
          file: 'test.js',
          line: 4,
        },
      ]);

      await backend.addEdges([
        // First call: addNode(config1)
        {
          src: 'test.js->global->CALL->addNode#0',
          dst: 'test.js->global->VARIABLE->config1',
          edgeType: 'PASSES_ARGUMENT',
          argIndex: 0,
        },
        {
          src: 'test.js->global->VARIABLE->config1',
          dst: 'test.js->global->OBJECT_LITERAL#0',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->OBJECT_LITERAL#0',
          dst: 'test.js->global->LITERAL->FUNCTION',
          edgeType: 'HAS_PROPERTY',
          propertyName: 'type',
        },
        // Second call: addNode(config2)
        {
          src: 'test.js->global->CALL->addNode#1',
          dst: 'test.js->global->VARIABLE->config2',
          edgeType: 'PASSES_ARGUMENT',
          argIndex: 0,
        },
        {
          src: 'test.js->global->VARIABLE->config2',
          dst: 'test.js->global->OBJECT_LITERAL#1',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->OBJECT_LITERAL#1',
          dst: 'test.js->global->LITERAL->CLASS',
          edgeType: 'HAS_PROPERTY',
          propertyName: 'type',
        },
      ]);
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'addNode',
        argIndex: 0,
        propertyPath: ['type'],
        raw: 'addNode#0.type',
      });

      assert.strictEqual(result.statistics.callSites, 2, 'Should find 2 call sites');
      assert.strictEqual(result.possibleValues.length, 2, 'Should find 2 unique values');

      const values = result.possibleValues.map(pv => pv.value).sort();
      assert.deepStrictEqual(values, ['CLASS', 'FUNCTION']);
    });
  });

  describe('tracing entire argument (no property path)', () => {
    it('should trace entire argument when no property specified', async () => {
      // Setup: addNode(42) - direct literal argument
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->addNode#0',
          nodeType: 'CALL',
          name: 'addNode',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->LITERAL->42',
          nodeType: 'LITERAL',
          value: 42,
          valueType: 'number',
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdge({
        src: 'test.js->global->CALL->addNode#0',
        dst: 'test.js->global->LITERAL->42',
        edgeType: 'PASSES_ARGUMENT',
        argIndex: 0,
      });
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      // Trace entire argument (no property path)
      const result = await resolveSink(backend, {
        functionName: 'addNode',
        argIndex: 0,
        propertyPath: [],  // Empty = trace entire argument
        raw: 'addNode#0',
      });

      assert.strictEqual(result.statistics.callSites, 1);
      assert.strictEqual(result.possibleValues.length, 1);
      assert.strictEqual(result.possibleValues[0].value, 42);
    });

    it('should trace variable to literal when no property specified', async () => {
      // Setup: const x = 'hello'; fn(x);
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->fn#0',
          nodeType: 'CALL',
          name: 'fn',
          file: 'test.js',
          line: 5,
        },
        {
          id: 'test.js->global->VARIABLE->x',
          nodeType: 'VARIABLE',
          name: 'x',
          file: 'test.js',
          line: 3,
        },
        {
          id: 'test.js->global->LITERAL->hello',
          nodeType: 'LITERAL',
          value: 'hello',
          valueType: 'string',
          file: 'test.js',
          line: 3,
        },
      ]);

      await backend.addEdges([
        {
          src: 'test.js->global->CALL->fn#0',
          dst: 'test.js->global->VARIABLE->x',
          edgeType: 'PASSES_ARGUMENT',
          argIndex: 0,
        },
        {
          src: 'test.js->global->VARIABLE->x',
          dst: 'test.js->global->LITERAL->hello',
          edgeType: 'ASSIGNED_FROM',
        },
      ]);
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'fn',
        argIndex: 0,
        propertyPath: [],
        raw: 'fn#0',
      });

      assert.strictEqual(result.possibleValues.length, 1);
      assert.strictEqual(result.possibleValues[0].value, 'hello');
    });
  });

  describe('edge cases', () => {
    it('should return empty possibleValues when function not found', async () => {
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'nonexistent',
        argIndex: 0,
        propertyPath: ['type'],
        raw: 'nonexistent#0.type',
      });

      assert.strictEqual(result.statistics.callSites, 0);
      assert.strictEqual(result.possibleValues.length, 0);
    });

    it('should skip call site when argument index out of range', async () => {
      // Setup: Call with 1 argument, but we ask for argIndex: 5
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->fn#0',
          nodeType: 'CALL',
          name: 'fn',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->LITERAL->x',
          nodeType: 'LITERAL',
          value: 'x',
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdge({
        src: 'test.js->global->CALL->fn#0',
        dst: 'test.js->global->LITERAL->x',
        edgeType: 'PASSES_ARGUMENT',
        argIndex: 0,
      });
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'fn',
        argIndex: 5,  // Out of range
        propertyPath: [],
        raw: 'fn#5',
      });

      // Should find 1 call site but 0 values (argument doesn't exist)
      assert.strictEqual(result.statistics.callSites, 1);
      assert.strictEqual(result.possibleValues.length, 0);
    });

    it('should mark unknown when property does not exist', async () => {
      // Setup: config = { type: "FUNCTION" }, but we ask for .name
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->fn#0',
          nodeType: 'CALL',
          name: 'fn',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->VARIABLE->config',
          nodeType: 'VARIABLE',
          name: 'config',
          file: 'test.js',
          line: 5,
        },
        {
          id: 'test.js->global->OBJECT_LITERAL#0',
          nodeType: 'OBJECT_LITERAL',
          file: 'test.js',
          line: 5,
        },
        {
          id: 'test.js->global->LITERAL->FUNCTION',
          nodeType: 'LITERAL',
          value: 'FUNCTION',
          file: 'test.js',
          line: 5,
        },
      ]);

      await backend.addEdges([
        {
          src: 'test.js->global->CALL->fn#0',
          dst: 'test.js->global->VARIABLE->config',
          edgeType: 'PASSES_ARGUMENT',
          argIndex: 0,
        },
        {
          src: 'test.js->global->VARIABLE->config',
          dst: 'test.js->global->OBJECT_LITERAL#0',
          edgeType: 'ASSIGNED_FROM',
        },
        {
          src: 'test.js->global->OBJECT_LITERAL#0',
          dst: 'test.js->global->LITERAL->FUNCTION',
          edgeType: 'HAS_PROPERTY',
          propertyName: 'type',  // Not 'name'
        },
      ]);
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'fn',
        argIndex: 0,
        propertyPath: ['name'],  // Doesn't exist
        raw: 'fn#0.name',
      });

      assert.strictEqual(result.statistics.unknownElements, true);
    });

    it('should handle method calls (obj.fn()) same as direct calls', async () => {
      // Setup: graph.addNode(config)
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->graph.addNode#0',
          nodeType: 'CALL',
          name: 'graph.addNode',
          method: 'addNode',
          object: 'graph',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->LITERAL->NODE',
          nodeType: 'LITERAL',
          value: 'NODE',
          valueType: 'string',
          file: 'test.js',
          line: 10,
        },
      ]);

      await backend.addEdge({
        src: 'test.js->global->CALL->graph.addNode#0',
        dst: 'test.js->global->LITERAL->NODE',
        edgeType: 'PASSES_ARGUMENT',
        argIndex: 0,
      });
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'addNode',  // Just method name, not "graph.addNode"
        argIndex: 0,
        propertyPath: [],
        raw: 'addNode#0',
      });

      assert.strictEqual(result.statistics.callSites, 1);
      assert.strictEqual(result.possibleValues.length, 1);
      assert.strictEqual(result.possibleValues[0].value, 'NODE');
    });

    it('should detect PARAMETER as nondeterministic source', async () => {
      // Setup: fn(userInput) where userInput is a PARAMETER
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->fn#0',
          nodeType: 'CALL',
          name: 'fn',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->handler->PARAMETER->userInput',
          nodeType: 'PARAMETER',
          name: 'userInput',
          file: 'test.js',
          line: 5,
        },
      ]);

      await backend.addEdge({
        src: 'test.js->global->CALL->fn#0',
        dst: 'test.js->global->handler->PARAMETER->userInput',
        edgeType: 'PASSES_ARGUMENT',
        argIndex: 0,
      });
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'fn',
        argIndex: 0,
        propertyPath: [],
        raw: 'fn#0',
      });

      // Parameters are nondeterministic - mark as unknown
      assert.strictEqual(result.statistics.unknownElements, true);
    });
  });

  describe('output structure', () => {
    it('should return correct output structure with sources', async () => {
      // Setup: Simple case with one literal value
      await backend.addNodes([
        {
          id: 'src/app.js->global->CALL->fn#0',
          nodeType: 'CALL',
          name: 'fn',
          file: 'src/app.js',
          line: 10,
        },
        {
          id: 'src/app.js->global->LITERAL->test',
          nodeType: 'LITERAL',
          value: 'test',
          valueType: 'string',
          file: 'src/app.js',
          line: 10,
          column: 5,
        },
      ]);

      await backend.addEdge({
        src: 'src/app.js->global->CALL->fn#0',
        dst: 'src/app.js->global->LITERAL->test',
        edgeType: 'PASSES_ARGUMENT',
        argIndex: 0,
      });
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'fn',
        argIndex: 0,
        propertyPath: [],
        raw: 'fn#0',
      });

      // Verify structure
      assert.ok(result.sink, 'Should have sink field');
      assert.strictEqual(result.sink.raw, 'fn#0');

      assert.ok(Array.isArray(result.resolvedCallSites), 'Should have resolvedCallSites array');
      assert.strictEqual(result.resolvedCallSites.length, 1);
      assert.strictEqual(result.resolvedCallSites[0].file, 'src/app.js');
      assert.strictEqual(result.resolvedCallSites[0].line, 10);

      assert.ok(Array.isArray(result.possibleValues), 'Should have possibleValues array');
      assert.strictEqual(result.possibleValues.length, 1);
      assert.strictEqual(result.possibleValues[0].value, 'test');
      assert.ok(Array.isArray(result.possibleValues[0].sources), 'Each value should have sources');

      assert.ok(result.statistics, 'Should have statistics field');
      assert.strictEqual(result.statistics.callSites, 1);
      assert.strictEqual(result.statistics.uniqueValues, 1);
    });

    it('should deduplicate same values from different call sites', async () => {
      // Setup: Two calls passing same literal value
      await backend.addNodes([
        {
          id: 'test.js->global->CALL->fn#0',
          nodeType: 'CALL',
          name: 'fn',
          file: 'test.js',
          line: 10,
        },
        {
          id: 'test.js->global->CALL->fn#1',
          nodeType: 'CALL',
          name: 'fn',
          file: 'test.js',
          line: 20,
        },
        {
          id: 'test.js->global->LITERAL->same',
          nodeType: 'LITERAL',
          value: 'same',
          valueType: 'string',
          file: 'test.js',
          line: 5,
        },
      ]);

      await backend.addEdges([
        {
          src: 'test.js->global->CALL->fn#0',
          dst: 'test.js->global->LITERAL->same',
          edgeType: 'PASSES_ARGUMENT',
          argIndex: 0,
        },
        {
          src: 'test.js->global->CALL->fn#1',
          dst: 'test.js->global->LITERAL->same',
          edgeType: 'PASSES_ARGUMENT',
          argIndex: 0,
        },
      ]);
      await backend.flush();

      const resolveSink = getSinkResolver();
      if (!resolveSink) {
        throw new Error('resolveSink not implemented yet (expected for TDD)');
      }

      const result = await resolveSink(backend, {
        functionName: 'fn',
        argIndex: 0,
        propertyPath: [],
        raw: 'fn#0',
      });

      assert.strictEqual(result.statistics.callSites, 2, 'Should find 2 call sites');
      assert.strictEqual(result.statistics.uniqueValues, 1, 'Should have 1 unique value');
      assert.strictEqual(result.possibleValues.length, 1, 'Should deduplicate to 1 value');
      assert.strictEqual(result.possibleValues[0].value, 'same');
      // The value should have sources from both call sites
      assert.strictEqual(result.possibleValues[0].sources.length, 2, 'Should track both sources');
    });
  });
});

/**
 * ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * Get parseSinkSpec from loaded module
 */
function getSinkSpecParser() {
  if (!traceModule || !traceModule.parseSinkSpec) {
    throw new Error('parseSinkSpec not implemented yet (expected for TDD)');
  }
  return traceModule.parseSinkSpec;
}

/**
 * Get findCallSites from loaded module
 */
function getCallSiteFinder() {
  if (!traceModule || !traceModule.findCallSites) {
    throw new Error('findCallSites not implemented yet (expected for TDD)');
  }
  return traceModule.findCallSites;
}

/**
 * Get extractArgument from loaded module
 */
function getArgumentExtractor() {
  if (!traceModule || !traceModule.extractArgument) {
    throw new Error('extractArgument not implemented yet (expected for TDD)');
  }
  return traceModule.extractArgument;
}

/**
 * Get resolveSink from loaded module
 */
function getSinkResolver() {
  if (!traceModule || !traceModule.resolveSink) {
    throw new Error('resolveSink not implemented yet (expected for TDD)');
  }
  return traceModule.resolveSink;
}
