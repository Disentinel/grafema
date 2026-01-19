/**
 * Тест для Socket.IO паттернов
 * Проверяем: emit, on, join, rooms, namespaces
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { assertGraph } from '../helpers/GraphAsserter.js';
import { TestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { SocketIOAnalyzer } from '@grafema/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_PATH = join(__dirname, '../fixtures/06-socketio');

describe('Socket.IO Analysis', () => {
  let backend;
  let orchestrator;

  beforeEach(async () => {
    backend = new TestBackend();
    await backend.connect();
    // Добавляем SocketIOAnalyzer к стандартным плагинам
    orchestrator = createTestOrchestrator(backend, {
      extraPlugins: [new SocketIOAnalyzer()]
    });
  });

  afterEach(async () => {
    if (backend) await backend.cleanup();
  });

  it('should detect SERVICE from package.json', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('SERVICE', 'socketio-fixture')
      .hasNodeCount('SERVICE', 1);
  });

  it('should detect all MODULE files', async () => {
    await orchestrator.run(FIXTURE_PATH);

    (await assertGraph(backend))
      .hasNode('MODULE', 'index.js')
      .hasNode('MODULE', 'server.js')
      .hasNode('MODULE', 'client.js')
      .hasNodeCount('MODULE', 3);
  });

  describe('Server Socket.IO Patterns (server.js)', () => {
    it('should detect socket emit events', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // server.js содержит:
      // io.emit('server:ready', ...)
      // io.to('gig:123').emit('slot:booked', ...)
      // socket.emit('slot:booked', result)
      // io.emit('heartbeat', ...)

      const allNodes = await backend.getAllNodes();
      const emitNodes = allNodes.filter(n => n.type === 'socketio:emit');

      assert.ok(emitNodes.length >= 4,
        `Expected at least 4 socketio:emit nodes, got ${emitNodes.length}`);
    });

    it('should detect socket.on listeners', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // server.js содержит:
      // io.on('connection', ...)
      // socket.on('slot:book', ...)
      // socket.on('message', ...)
      // socket.on('user:typing', ...)
      // socket.on('disconnect', ...)

      const allNodes = await backend.getAllNodes();
      const onNodes = allNodes.filter(n => n.type === 'socketio:on');

      assert.ok(onNodes.length >= 5,
        `Expected at least 5 socketio:on nodes, got ${onNodes.length}`);
    });

    it('should detect socket.join rooms', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // server.js содержит:
      // socket.join('gig:123')
      // socket.join(`user:${socket.userId}`)

      const allNodes = await backend.getAllNodes();
      const roomNodes = allNodes.filter(n => n.type === 'socketio:room');

      assert.ok(roomNodes.length >= 2,
        `Expected at least 2 socketio:room nodes, got ${roomNodes.length}`);
    });

    it('should detect specific event names', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const emitNodes = allNodes.filter(n => n.type === 'socketio:emit');

      const events = emitNodes.map(n => n.event);
      assert.ok(events.includes('server:ready'), 'Should detect server:ready event');
      assert.ok(events.includes('slot:booked'), 'Should detect slot:booked event');
    });

    it('should detect room-based emits', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const roomEmits = allNodes.filter(n =>
        n.type === 'socketio:emit' && n.room
      );

      assert.ok(roomEmits.length >= 1,
        `Expected at least 1 room-based emit, got ${roomEmits.length}`);
    });

    it('should detect namespace-based emits', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // io.of('/admin').emit('user:joined', ...)
      const allNodes = await backend.getAllNodes();
      const namespaceEmits = allNodes.filter(n =>
        n.type === 'socketio:emit' && n.namespace
      );

      assert.ok(namespaceEmits.length >= 1,
        `Expected at least 1 namespace-based emit, got ${namespaceEmits.length}`);
    });

    it('should detect broadcast emits', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // socket.broadcast.emit('user:typing', ...)
      const allNodes = await backend.getAllNodes();
      const broadcastEmits = allNodes.filter(n =>
        n.type === 'socketio:emit' && n.broadcast === true
      );

      assert.ok(broadcastEmits.length >= 1,
        `Expected at least 1 broadcast emit, got ${broadcastEmits.length}`);
    });
  });

  describe('Client Socket.IO Patterns (client.js)', () => {
    it('should detect client socket.on listeners', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js содержит:
      // socket.on('connect', ...)
      // socket.on('slot:booked', ...)
      // socket.on('message:received', ...)
      // socket.on('user:typing', ...)
      // socket.on('disconnect', ...)

      const allNodes = await backend.getAllNodes();
      const clientOnNodes = allNodes.filter(n =>
        n.type === 'socketio:on' && n.file && n.file.includes('client.js')
      );

      assert.ok(clientOnNodes.length >= 5,
        `Expected at least 5 client socketio:on nodes, got ${clientOnNodes.length}`);
    });

    it('should detect client socket.emit calls', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js содержит:
      // socket.emit('slot:book', ...)
      // socket.emit('message', ...)

      const allNodes = await backend.getAllNodes();
      const clientEmits = allNodes.filter(n =>
        n.type === 'socketio:emit' && n.file && n.file.includes('client.js')
      );

      assert.ok(clientEmits.length >= 2,
        `Expected at least 2 client socketio:emit nodes, got ${clientEmits.length}`);
    });
  });

  describe('Graph Structure Validation', () => {
    it('should have valid graph structure', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .allEdgesValid()
        .noDuplicateIds();
    });

    it('should connect modules to service', async () => {
      await orchestrator.run(FIXTURE_PATH);

      (await assertGraph(backend))
        .hasEdge('SERVICE', 'socketio-fixture', 'CONTAINS', 'MODULE', 'index.js')
        .hasEdge('SERVICE', 'socketio-fixture', 'CONTAINS', 'MODULE', 'server.js')
        .hasEdge('SERVICE', 'socketio-fixture', 'CONTAINS', 'MODULE', 'client.js');
    });

    it('should connect socketio:emit nodes to modules via CONTAINS', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allEdges = await backend.getAllEdges();
      const containsEdges = allEdges.filter(e => e.type === 'CONTAINS');

      // Должны быть CONTAINS ребра от MODULE к socketio:emit
      const allNodes = await backend.getAllNodes();
      const moduleIds = new Set(allNodes.filter(n => n.type === 'MODULE').map(n => n.id));
      const socketEmitIds = new Set(allNodes.filter(n => n.type === 'socketio:emit').map(n => n.id));

      const moduleToEmitEdges = containsEdges.filter(e =>
        moduleIds.has(e.fromId || e.src) && socketEmitIds.has(e.toId || e.dst)
      );

      assert.ok(moduleToEmitEdges.length >= 1,
        'Should have CONTAINS edges from MODULE to socketio:emit');
    });
  });

  describe('Function Detection', () => {
    it('should detect server functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // server.js: notifySlotBooked
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'notifySlotBooked');
    });

    it('should detect client functions', async () => {
      await orchestrator.run(FIXTURE_PATH);

      // client.js: bookSlot, sendMessage, useSocket, GigView
      (await assertGraph(backend))
        .hasNode('FUNCTION', 'bookSlot')
        .hasNode('FUNCTION', 'sendMessage')
        .hasNode('FUNCTION', 'useSocket')
        .hasNode('FUNCTION', 'GigView');
    });
  });
});
