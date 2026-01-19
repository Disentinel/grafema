/**
 * Test for Rust FFI plugins
 * Tests RustModuleIndexer, RustAnalyzer, and RustFFIEnricher
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { assertGraph } from '../helpers/GraphAsserter.js';
import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { RustModuleIndexer } from '@grafema/core';
import { RustAnalyzer } from '@grafema/core';
import { RustFFIEnricher } from '@grafema/core';
import { MethodCallResolver } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/rust-ffi');

describe('Rust FFI Analysis', () => {
  let backend;
  let orchestrator;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();

    // Create orchestrator with Rust plugins
    orchestrator = createTestOrchestrator(backend, {
      extraPlugins: [
        new RustModuleIndexer(),
        new RustAnalyzer(),
        new MethodCallResolver(),
        new RustFFIEnricher(),
      ]
    });
  });

  afterEach(async () => {
    if (backend) await backend.cleanup();
  });

  it('should detect RUST_MODULE from lib.rs', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - RUST_MODULE node for lib.rs

    const modules = [];
    for await (const node of backend.queryNodes({ nodeType: 'RUST_MODULE' })) {
      modules.push(node);
    }

    assert.ok(modules.length > 0, 'Should find at least one RUST_MODULE');

    const libModule = modules.find(m => m.name === 'crate' || m.file?.endsWith('lib.rs'));
    assert.ok(libModule, 'Should find lib.rs as crate module');

    console.log('Found RUST_MODULE:', libModule.name);
  });

  it('should detect RUST_STRUCT with #[napi]', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - RUST_STRUCT: GraphEngine with napi=true

    const structs = [];
    for await (const node of backend.queryNodes({ nodeType: 'RUST_STRUCT' })) {
      structs.push(node);
    }

    const graphEngine = structs.find(s => s.name === 'GraphEngine');
    assert.ok(graphEngine, 'Should find GraphEngine struct');
    assert.strictEqual(graphEngine.napi, true, 'GraphEngine should have napi=true');

    console.log('Found RUST_STRUCT:', graphEngine.name, 'napi:', graphEngine.napi);
  });

  it('should detect RUST_METHOD with #[napi] from impl block', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - RUST_METHOD: add_node, get_nodes, get_node_count

    const methods = [];
    for await (const node of backend.queryNodes({ nodeType: 'RUST_METHOD' })) {
      methods.push(node);
    }

    const addNode = methods.find(m => m.name === 'add_node');
    const getNodes = methods.find(m => m.name === 'get_nodes');
    const getNodeCount = methods.find(m => m.name === 'get_node_count');

    assert.ok(addNode, 'Should find add_node method');
    assert.ok(getNodes, 'Should find get_nodes method');
    assert.ok(getNodeCount, 'Should find get_node_count method');

    assert.strictEqual(addNode.napi, true, 'add_node should have napi=true');
    assert.strictEqual(getNodeCount.napiJsName, 'nodeCount', 'get_node_count should have js_name');

    console.log('Found RUST_METHODs:', methods.map(m => m.name).join(', '));
  });

  it('should detect RUST_FUNCTION with #[napi]', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - RUST_FUNCTION: compute_hash with napi=true
    // - internal_helper without napi

    const functions = [];
    for await (const node of backend.queryNodes({ nodeType: 'RUST_FUNCTION' })) {
      functions.push(node);
    }

    const computeHash = functions.find(f => f.name === 'compute_hash');
    const internalHelper = functions.find(f => f.name === 'internal_helper');

    assert.ok(computeHash, 'Should find compute_hash function');
    assert.strictEqual(computeHash.napi, true, 'compute_hash should have napi=true');

    // internal_helper should exist but without napi
    if (internalHelper) {
      assert.strictEqual(internalHelper.napi, false, 'internal_helper should not have napi');
    }

    console.log('Found RUST_FUNCTIONs:', functions.map(f => `${f.name}(napi=${f.napi})`).join(', '));
  });

  it('should detect RUST_IMPL block', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - RUST_IMPL: GraphEngine

    const impls = [];
    for await (const node of backend.queryNodes({ nodeType: 'RUST_IMPL' })) {
      impls.push(node);
    }

    const graphEngineImpl = impls.find(i => i.name === 'GraphEngine');
    assert.ok(graphEngineImpl, 'Should find GraphEngine impl block');

    console.log('Found RUST_IMPL:', graphEngineImpl.name);
  });

  it('should create CONTAINS edges from module to items', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // - RUST_MODULE -> CONTAINS -> RUST_STRUCT
    // - RUST_MODULE -> CONTAINS -> RUST_IMPL
    // - RUST_MODULE -> CONTAINS -> RUST_FUNCTION

    // Find module
    let moduleId;
    for await (const node of backend.queryNodes({ nodeType: 'RUST_MODULE' })) {
      if (node.file?.endsWith('lib.rs')) {
        moduleId = node.id;
        break;
      }
    }

    assert.ok(moduleId, 'Should find lib.rs module');

    // Check outgoing CONTAINS edges
    const edges = await backend.getOutgoingEdges(moduleId, ['CONTAINS']);
    assert.ok(edges.length > 0, 'Module should have CONTAINS edges');

    console.log('Found CONTAINS edges from module:', edges.length);
  });

  it('should detect RUST_CALL nodes inside methods', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // EXPECTED:
    // add_node() calls: self.validate_name(), self.nodes.push(), self.notify_change()
    // save_to_file() calls: std::fs::write(), self.serialize(), .unwrap()

    const calls = [];
    for await (const node of backend.queryNodes({ nodeType: 'RUST_CALL' })) {
      calls.push(node);
    }

    assert.ok(calls.length > 0, 'Should find RUST_CALL nodes');

    // Check for method calls
    const methodCalls = calls.filter(c => c.callType === 'method');
    const functionCalls = calls.filter(c => c.callType === 'function');
    const macroCalls = calls.filter(c => c.callType === 'macro');

    console.log('Found RUST_CALLs:', {
      total: calls.length,
      methods: methodCalls.length,
      functions: functionCalls.length,
      macros: macroCalls.length
    });

    // Should have method calls like self.validate_name, self.nodes.push
    assert.ok(methodCalls.length > 0, 'Should have method calls');

    // Print some examples
    console.log('Method call examples:', methodCalls.slice(0, 5).map(c =>
      `${c.receiver}.${c.method}()`
    ));

    // Check for side effect pattern: std::fs::write
    const fsWrite = functionCalls.find(c => c.name?.includes('fs') || c.name?.includes('write'));
    if (fsWrite) {
      console.log('Found fs call:', fsWrite.name);
    }
  });

  it('should create CONTAINS edges from method to calls', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // Find add_node method
    let addNodeMethod;
    for await (const node of backend.queryNodes({ nodeType: 'RUST_METHOD' })) {
      if (node.name === 'add_node') {
        addNodeMethod = node;
        break;
      }
    }

    assert.ok(addNodeMethod, 'Should find add_node method');

    // Check outgoing CONTAINS edges to RUST_CALL
    const edges = await backend.getOutgoingEdges(addNodeMethod.id, ['CONTAINS']);
    const callEdges = [];

    for (const edge of edges) {
      const target = await backend.getNode(edge.dst);
      if (target?.type === 'RUST_CALL') {
        callEdges.push({ edge, target });
      }
    }

    assert.ok(callEdges.length > 0, 'add_node should contain RUST_CALL nodes');
    console.log('add_node contains', callEdges.length, 'calls:',
      callEdges.map(e => e.target.method || e.target.name).join(', '));
  });

  it('should detect side effects on RUST_CALL nodes', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // Collect all calls with side effects
    const sideEffectCalls = [];
    for await (const node of backend.queryNodes({ nodeType: 'RUST_CALL' })) {
      if (node.sideEffect) {
        sideEffectCalls.push(node);
      }
    }

    assert.ok(sideEffectCalls.length > 0, 'Should find calls with side effects');

    // Group by side effect type
    const byEffect = {};
    for (const call of sideEffectCalls) {
      byEffect[call.sideEffect] = byEffect[call.sideEffect] || [];
      byEffect[call.sideEffect].push(call.method || call.name);
    }

    console.log('Side effects detected:', byEffect);

    // Check specific side effects
    // fs:write from std::fs::write
    assert.ok(byEffect['fs:write'], 'Should detect fs:write side effect');

    // fs:read from std::fs::read_to_string
    assert.ok(byEffect['fs:read'], 'Should detect fs:read side effect');

    // panic from .unwrap() and .expect()
    assert.ok(byEffect['panic'], 'Should detect panic side effect from unwrap/expect');

    // io:print from println!
    assert.ok(byEffect['io:print'], 'Should detect io:print side effect from println!');
  });

  it('should detect unsafe blocks in functions', async () => {
    await orchestrator.run(FIXTURE_PATH);

    // Find the unsafe_memory_op function
    let unsafeFunc;
    for await (const node of backend.queryNodes({ nodeType: 'RUST_FUNCTION' })) {
      if (node.name === 'unsafe_memory_op') {
        unsafeFunc = node;
        break;
      }
    }

    assert.ok(unsafeFunc, 'Should find unsafe_memory_op function');
    assert.strictEqual(unsafeFunc.unsafeBlocks, 2, 'unsafe_memory_op should have 2 unsafe blocks');

    console.log('Found unsafe_memory_op with', unsafeFunc.unsafeBlocks, 'unsafe blocks');

    // Check functions with no unsafe blocks have 0
    let safeFunc;
    for await (const node of backend.queryNodes({ nodeType: 'RUST_FUNCTION' })) {
      if (node.name === 'compute_hash') {
        safeFunc = node;
        break;
      }
    }

    assert.ok(safeFunc, 'Should find compute_hash function');
    assert.strictEqual(safeFunc.unsafeBlocks, 0, 'compute_hash should have 0 unsafe blocks');
  });
});
