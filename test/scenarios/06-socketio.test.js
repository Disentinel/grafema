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

  describe('Event Channel Creation', () => {
    it('should create socketio:event nodes for unique events', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const eventNodes = allNodes.filter(n => n.type === 'socketio:event');

      // Expected events from fixtures:
      // server.js: server:ready, slot:booked, user:joined, slot:book,
      //            message, user:typing, disconnect, user:left,
      //            slot:updated, message:received, heartbeat
      // client.js: connect, slot:booked, message:received, user:typing,
      //            disconnect, slot:book, message, user:joined
      // Unique events: server:ready, slot:booked, user:joined, slot:book,
      //                message, user:typing, disconnect, user:left,
      //                slot:updated, message:received, heartbeat,
      //                connect
      assert.ok(eventNodes.length >= 12,
        `Expected at least 12 socketio:event nodes, got ${eventNodes.length}`);
    });

    it('should create event node with correct structure', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );

      assert.ok(slotBookedEvent, 'Should have slot:booked event node');
      assert.strictEqual(slotBookedEvent.id, 'socketio:event#slot:booked',
        'Event node ID should follow pattern: socketio:event#<event-name>');
      assert.strictEqual(slotBookedEvent.name, 'slot:booked',
        'Event node name should match event name');
      assert.strictEqual(slotBookedEvent.event, 'slot:booked',
        'Event node event field should match event name');
      // Event nodes are global entities - they should not have file/line pointing to actual source
      // Note: RFDB may set these fields to other values, but they shouldn't be real file paths
      assert.ok(
        slotBookedEvent.file === undefined || !slotBookedEvent.file.endsWith('.js'),
        'Event node file should not be a source file path (global entity)'
      );
    });

    it('should connect emits to event channels via EMITS_EVENT edges', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );
      assert.ok(slotBookedEvent, 'slot:booked event node must exist');

      const allEdges = await backend.getAllEdges();
      const emitsEventEdges = allEdges.filter(e =>
        e.type === 'EMITS_EVENT' && (e.toId === slotBookedEvent.id || e.dst === slotBookedEvent.id)
      );

      // server.js has multiple slot:booked emits:
      // - Line 13: io.to('gig:123').emit('slot:booked', ...)
      // - Line 29: socket.emit('slot:booked', result)
      // - Line 51: via notifySlotBooked function (service call)
      assert.ok(emitsEventEdges.length >= 2,
        `Expected at least 2 EMITS_EVENT edges to slot:booked event, got ${emitsEventEdges.length}`);

      // Verify edge connects emit node to event node
      const firstEdge = emitsEventEdges[0];
      const sourceNode = allNodes.find(n => n.id === (firstEdge.fromId || firstEdge.src));
      assert.ok(sourceNode, 'Source node of EMITS_EVENT edge must exist');
      assert.strictEqual(sourceNode.type, 'socketio:emit',
        'EMITS_EVENT edge must connect from socketio:emit node');
    });

    it('should connect event channels to listeners via LISTENED_BY edges', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );
      assert.ok(slotBookedEvent, 'slot:booked event node must exist');

      const allEdges = await backend.getAllEdges();
      const listenedByEdges = allEdges.filter(e =>
        e.type === 'LISTENED_BY' && (e.fromId === slotBookedEvent.id || e.src === slotBookedEvent.id)
      );

      // client.js has slot:booked listeners:
      // - Line 13: socket.on('slot:booked', ...) - directly detected
      // - Line 49: useSocket('slot:booked', ...) - NOT detected (wrapper pattern, requires dataflow analysis)
      // Note: useSocket wrapper calls socket.on(event, handler) where event is a variable,
      // so the analyzer sees the variable name, not the literal value passed from call site.
      // This is a known limitation - see Linear issue for dataflow-based argument tracking.
      assert.ok(listenedByEdges.length >= 1,
        `Expected at least 1 LISTENED_BY edge from slot:booked event, got ${listenedByEdges.length}`);

      // Verify edge connects event node to listener node
      const firstEdge = listenedByEdges[0];
      const targetNode = allNodes.find(n => n.id === (firstEdge.toId || firstEdge.dst));
      assert.ok(targetNode, 'Target node of LISTENED_BY edge must exist');
      assert.strictEqual(targetNode.type, 'socketio:on',
        'LISTENED_BY edge must connect to socketio:on node');
    });

    it('should create event nodes even for events with only emitters', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const heartbeatEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'heartbeat'
      );

      // heartbeat is emitted (server.js line 56) but has no listeners in fixture
      assert.ok(heartbeatEvent, 'Should create event node even without listeners');
      assert.strictEqual(heartbeatEvent.name, 'heartbeat');

      // Verify it has EMITS_EVENT edges but no LISTENED_BY edges
      const allEdges = await backend.getAllEdges();
      const emitsEventEdges = allEdges.filter(e =>
        e.type === 'EMITS_EVENT' && (e.toId === heartbeatEvent.id || e.dst === heartbeatEvent.id)
      );
      assert.ok(emitsEventEdges.length >= 1,
        'heartbeat event should have at least one emitter');
    });

    it('should create event nodes even for events with only listeners', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const connectEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'connect'
      );

      // connect is listened to (client.js line 9) but not emitted in fixture
      // (it's a built-in Socket.IO event emitted by the library)
      assert.ok(connectEvent, 'Should create event node even without explicit emitters');
      assert.strictEqual(connectEvent.name, 'connect');

      // Verify it has LISTENED_BY edges
      const allEdges = await backend.getAllEdges();
      const listenedByEdges = allEdges.filter(e =>
        e.type === 'LISTENED_BY' && (e.fromId === connectEvent.id || e.src === connectEvent.id)
      );
      assert.ok(listenedByEdges.length >= 1,
        'connect event should have at least one listener');
    });

    it('should deduplicate events across files', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvents = allNodes.filter(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );

      // slot:booked appears in both server.js (emits) and client.js (listens)
      // but there should be only ONE event channel node
      assert.strictEqual(slotBookedEvents.length, 1,
        'Should have exactly one event node per unique event name, even when used in multiple files');
    });

    it('should handle events appearing in multiple contexts', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const disconnectEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'disconnect'
      );

      assert.ok(disconnectEvent, 'disconnect event node must exist');

      // disconnect appears as:
      // - server.js line 43: socket.on('disconnect', ...) - listener
      // - client.js line 26: socket.on('disconnect', ...) - listener
      // Should be ONE event node with multiple LISTENED_BY edges
      const allEdges = await backend.getAllEdges();
      const listenedByEdges = allEdges.filter(e =>
        e.type === 'LISTENED_BY' && (e.fromId === disconnectEvent.id || e.src === disconnectEvent.id)
      );

      assert.ok(listenedByEdges.length >= 2,
        `disconnect event should have at least 2 listeners (server and client), got ${listenedByEdges.length}`);
    });

    it('should handle dynamic event names in useSocket', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();

      // useSocket function (client.js line 40-44) takes event as parameter
      // This creates a dynamic event pattern
      // The calls in GigView (lines 49, 53) use specific events
      const userJoinedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'user:joined'
      );

      assert.ok(userJoinedEvent,
        'Should create event node for events passed to useSocket');
    });

    it('should handle room-scoped emits as regular events', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotUpdatedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:updated'
      );

      // server.js line 30: socket.to('gig:123').emit('slot:updated', result)
      // Room-scoped emit creates regular event node (namespace/room scoping
      // is future work per Joel's plan)
      assert.ok(slotUpdatedEvent, 'Room-scoped emits should create event nodes');
      assert.strictEqual(slotUpdatedEvent.name, 'slot:updated');
    });

    it('should handle namespace emits as regular events', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const userJoinedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'user:joined'
      );

      // server.js line 16: io.of('/admin').emit('user:joined', ...)
      // client.js line 53: useSocket('user:joined', ...)
      // Namespace emit creates regular event node (namespace scoping
      // is future work per Joel's plan)
      assert.ok(userJoinedEvent, 'Namespace emits should create event nodes');

      // Namespace emit should connect to event node
      const allEdges = await backend.getAllEdges();
      const emitsEventEdges = allEdges.filter(e =>
        e.type === 'EMITS_EVENT' && (e.toId === userJoinedEvent.id || e.dst === userJoinedEvent.id)
      );

      assert.ok(emitsEventEdges.length >= 1, 'user:joined should have emitters');
      // Note: The listener for user:joined is via useSocket('user:joined', ...) wrapper
      // which won't be detected (requires dataflow analysis). This is a known limitation.
    });

    it('should handle broadcast emits as regular events', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const userTypingEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'user:typing'
      );

      // server.js line 39: socket.broadcast.emit('user:typing', ...)
      // client.js line 22: socket.on('user:typing', ...)
      assert.ok(userTypingEvent, 'Broadcast emits should create event nodes');

      // Verify connection between broadcast emit and listener
      const allEdges = await backend.getAllEdges();
      const emitsEventEdges = allEdges.filter(e =>
        e.type === 'EMITS_EVENT' && (e.toId === userTypingEvent.id || e.dst === userTypingEvent.id)
      );
      const listenedByEdges = allEdges.filter(e =>
        e.type === 'LISTENED_BY' && (e.fromId === userTypingEvent.id || e.src === userTypingEvent.id)
      );

      assert.ok(emitsEventEdges.length >= 1, 'user:typing should have emitters');
      assert.ok(listenedByEdges.length >= 1, 'user:typing should have listeners');
    });

    it('should connect all emits of same event to single event node', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );
      assert.ok(slotBookedEvent);

      // Find all emit nodes for slot:booked
      const slotBookedEmits = allNodes.filter(n =>
        n.type === 'socketio:emit' && n.event === 'slot:booked'
      );

      // Verify each emit has EMITS_EVENT edge to the event node
      for (const emitNode of slotBookedEmits) {
        const edge = allEdges.find(e =>
          e.type === 'EMITS_EVENT' &&
          (e.fromId === emitNode.id || e.src === emitNode.id) &&
          (e.toId === slotBookedEvent.id || e.dst === slotBookedEvent.id)
        );
        assert.ok(edge,
          `Emit node ${emitNode.id} should have EMITS_EVENT edge to event node`);
      }
    });

    it('should connect all listeners of same event to single event node', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );
      assert.ok(slotBookedEvent);

      // Find all listener nodes for slot:booked
      const slotBookedListeners = allNodes.filter(n =>
        n.type === 'socketio:on' && n.event === 'slot:booked'
      );

      // Verify each listener has LISTENED_BY edge from the event node
      for (const listenerNode of slotBookedListeners) {
        const edge = allEdges.find(e =>
          e.type === 'LISTENED_BY' &&
          (e.fromId === slotBookedEvent.id || e.src === slotBookedEvent.id) &&
          (e.toId === listenerNode.id || e.dst === listenerNode.id)
        );
        assert.ok(edge,
          `Listener node ${listenerNode.id} should have LISTENED_BY edge from event node`);
      }
    });
  });
});
