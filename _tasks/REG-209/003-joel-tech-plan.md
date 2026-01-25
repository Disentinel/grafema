# REG-209: Socket.IO Events Searchability - Technical Implementation Plan

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2025-01-25
**Based on:** Don Melton's plan (002-don-plan.md)

## Executive Summary

This plan details the implementation of Socket.IO event searchability by creating `socketio:event` nodes as first-class entities in the graph. This enables both searching and tracing of event flow from emitters to listeners.

**Approach:** Don's Option B (Event Channel Nodes) - create event nodes and connect them to emitters/listeners via new edge types.

**Files to modify:**
1. `/packages/core/src/plugins/analysis/SocketIOAnalyzer.ts` - Create event nodes and edges
2. `/packages/cli/src/commands/query.ts` - Add search support for Socket.IO types
3. `/packages/cli/src/commands/overview.ts` - Show event count in overview
4. `/test/scenarios/06-socketio.test.js` - Add tests for new functionality

**Estimated time:** 6 hours

---

## Part 1: SocketIOAnalyzer Changes

### File: `/packages/core/src/plugins/analysis/SocketIOAnalyzer.ts`

#### 1.1 Update Metadata (lines 83-94)

**Current:**
```typescript
get metadata(): PluginMetadata {
  return {
    name: 'SocketIOAnalyzer',
    phase: 'ANALYSIS',
    priority: 75,
    creates: {
      nodes: ['socketio:emit', 'socketio:on', 'socketio:room'],
      edges: ['CONTAINS', 'EMITS_EVENT', 'LISTENS_TO', 'JOINS_ROOM']
    },
    dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
  };
}
```

**Change to:**
```typescript
get metadata(): PluginMetadata {
  return {
    name: 'SocketIOAnalyzer',
    phase: 'ANALYSIS',
    priority: 75,
    creates: {
      nodes: ['socketio:emit', 'socketio:on', 'socketio:room', 'socketio:event'],
      edges: ['CONTAINS', 'EMITS_EVENT', 'LISTENS_TO', 'JOINS_ROOM', 'LISTENED_BY']
    },
    dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
  };
}
```

**Why:** Add `socketio:event` to node types and `LISTENED_BY` to edge types.

---

#### 1.2 Add Interface for Event Node (after line 72)

**Insert after `SocketRoomNode` interface:**

```typescript
/**
 * Socket event channel node - represents a single event across all emitters/listeners
 */
interface SocketEventNode {
  id: string;
  type: 'socketio:event';
  name: string;        // Event name (e.g., "slot:booked")
  event: string;       // Same as name, for consistency
  file?: string;       // Not applicable - event is global
  line?: number;       // Not applicable
}
```

**Why:** TypeScript interface for the new node type. We include `event` field for consistency with emit/listener nodes, but `name` is the primary searchable field.

---

#### 1.3 Modify `execute()` Method (lines 96-144)

**Current structure:**
```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  // ... setup ...

  for (let i = 0; i < modules.length; i++) {
    const module = modules[i];
    const result = await this.analyzeModule(module, graph);
    emitsCount += result.emits;
    listenersCount += result.listeners;
    roomsCount += result.rooms;
    // ... progress logging ...
  }

  logger.info('Analysis complete', { emitsCount, listenersCount, roomsCount });

  return createSuccessResult(
    { nodes: emitsCount + listenersCount + roomsCount, edges: 0 },
    { emitsCount, listenersCount, roomsCount }
  );
}
```

**Change to:**

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const logger = this.log(context);

  try {
    const { graph } = context;

    // Получаем все модули
    const modules = await this.getModules(graph);
    logger.info('Processing modules', { count: modules.length });

    let emitsCount = 0;
    let listenersCount = 0;
    let roomsCount = 0;
    const startTime = Date.now();

    // PHASE 1: Analyze modules and create emit/listener/room nodes
    for (let i = 0; i < modules.length; i++) {
      const module = modules[i];
      const result = await this.analyzeModule(module, graph);
      emitsCount += result.emits;
      listenersCount += result.listeners;
      roomsCount += result.rooms;

      // Progress every 20 modules
      if ((i + 1) % 20 === 0 || i === modules.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const avgTime = ((Date.now() - startTime) / (i + 1)).toFixed(0);
        logger.debug('Progress', {
          current: i + 1,
          total: modules.length,
          elapsed: `${elapsed}s`,
          avgTime: `${avgTime}ms/module`
        });
      }
    }

    // PHASE 2: Create event channel nodes and edges
    const eventCount = await this.createEventChannels(graph, logger);

    logger.info('Analysis complete', {
      emitsCount,
      listenersCount,
      roomsCount,
      eventCount
    });

    return createSuccessResult(
      {
        nodes: emitsCount + listenersCount + roomsCount + eventCount,
        edges: 0
      },
      { emitsCount, listenersCount, roomsCount, eventCount }
    );
  } catch (error) {
    logger.error('Analysis failed', { error });
    return createErrorResult(error as Error);
  }
}
```

**Why:** Split analysis into two phases:
1. Phase 1: Create emit/listener/room nodes (existing behavior)
2. Phase 2: Create event channel nodes and connect them

This follows the **cross-file operations pattern** from `_ai/grafema-patterns.md` - event channels connect nodes from different files, so they must be created AFTER all emit/listener nodes exist.

---

#### 1.4 Add `createEventChannels()` Method (insert before `analyzeModule()`)

**Insert at line 145 (right before `private async analyzeModule()`):**

```typescript
/**
 * Create event channel nodes and connect them to emits/listeners
 *
 * This runs AFTER all modules are analyzed, so all emit/listener nodes exist.
 * Creates one socketio:event node per unique event name, then connects:
 * - socketio:emit → EMITS_EVENT → socketio:event
 * - socketio:event → LISTENED_BY → socketio:on
 */
private async createEventChannels(
  graph: PluginContext['graph'],
  logger: ReturnType<typeof this.log>
): Promise<number> {
  try {
    // Step 1: Get all emit and listener nodes
    const allEmits = await graph.getAllNodes({ type: 'socketio:emit' });
    const allListeners = await graph.getAllNodes({ type: 'socketio:on' });

    logger.debug('Creating event channels', {
      emits: allEmits.length,
      listeners: allListeners.length
    });

    // Step 2: Extract unique event names
    const eventNames = new Set<string>();

    for (const emit of allEmits) {
      if (emit.event && typeof emit.event === 'string') {
        eventNames.add(emit.event);
      }
    }

    for (const listener of allListeners) {
      if (listener.event && typeof listener.event === 'string') {
        eventNames.add(listener.event);
      }
    }

    logger.debug('Unique events found', { count: eventNames.size });

    // Step 3: Create event channel node for each unique event
    let createdCount = 0;
    for (const eventName of eventNames) {
      const eventNodeId = `socketio:event#${eventName}`;

      // Create event channel node
      const eventNode: SocketEventNode = {
        id: eventNodeId,
        type: 'socketio:event',
        name: eventName,
        event: eventName
      };

      await graph.addNode(eventNode as unknown as NodeRecord);
      createdCount++;

      // Step 4: Connect all emits of this event to the channel
      const matchingEmits = allEmits.filter(e => e.event === eventName);
      for (const emit of matchingEmits) {
        await graph.addEdge({
          type: 'EMITS_EVENT',
          src: emit.id,
          dst: eventNodeId
        });
      }

      // Step 5: Connect event channel to all listeners of this event
      const matchingListeners = allListeners.filter(l => l.event === eventName);
      for (const listener of matchingListeners) {
        await graph.addEdge({
          type: 'LISTENED_BY',
          src: eventNodeId,
          dst: listener.id
        });
      }

      logger.debug('Created event channel', {
        event: eventName,
        emits: matchingEmits.length,
        listeners: matchingListeners.length
      });
    }

    return createdCount;
  } catch (error) {
    logger.error('Failed to create event channels', { error });
    return 0;
  }
}
```

**Why:**
- Deduplicates event names across all modules
- Creates one `socketio:event` node per unique event
- Connects emits and listeners via the event node
- Runs AFTER module analysis to ensure all emit/listener nodes exist
- Handles edge case where event has no emitters or no listeners

**Edge cases handled:**
- Events with only emitters (no listeners): Event node created, only EMITS_EVENT edges
- Events with only listeners (no emitters): Event node created, only LISTENED_BY edges
- Dynamic event names (`user:${id}`): Treated as separate events (e.g., `user:${...}`)

---

## Part 2: Query Command Changes

### File: `/packages/cli/src/commands/query.ts`

#### 2.1 Add Socket.IO Types to Search List (line 232-234)

**Current:**
```typescript
const searchTypes = type
  ? [type]
  : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT', 'http:route'];
```

**Change to:**
```typescript
const searchTypes = type
  ? [type]
  : [
      'FUNCTION',
      'CLASS',
      'MODULE',
      'VARIABLE',
      'CONSTANT',
      'http:route',
      'socketio:event',
      'socketio:emit',
      'socketio:on'
    ];
```

**Why:** Makes Socket.IO node types searchable by default when no type is specified.

---

#### 2.2 Add Type Aliases (line 154-168)

**Current:**
```typescript
const typeMap: Record<string, string> = {
  function: 'FUNCTION',
  fn: 'FUNCTION',
  func: 'FUNCTION',
  class: 'CLASS',
  module: 'MODULE',
  variable: 'VARIABLE',
  var: 'VARIABLE',
  const: 'CONSTANT',
  constant: 'CONSTANT',
  // HTTP route aliases
  route: 'http:route',
  endpoint: 'http:route',
  http: 'http:route',
};
```

**Change to:**
```typescript
const typeMap: Record<string, string> = {
  function: 'FUNCTION',
  fn: 'FUNCTION',
  func: 'FUNCTION',
  class: 'CLASS',
  module: 'MODULE',
  variable: 'VARIABLE',
  var: 'VARIABLE',
  const: 'CONSTANT',
  constant: 'CONSTANT',
  // HTTP route aliases
  route: 'http:route',
  endpoint: 'http:route',
  http: 'http:route',
  // Socket.IO aliases
  event: 'socketio:event',
  emit: 'socketio:emit',
  on: 'socketio:on',
  listener: 'socketio:on',
};
```

**Why:** Allows users to search using natural language:
- `grafema query "event slot:booked"` → finds socketio:event nodes
- `grafema query "emit slot:booked"` → finds socketio:emit nodes
- `grafema query "on slot:booked"` → finds socketio:on nodes

---

#### 2.3 Update `matchesSearchPattern()` (lines 185-220)

**Current:**
```typescript
function matchesSearchPattern(
  node: { name?: string; method?: string; path?: string; [key: string]: unknown },
  nodeType: string,
  pattern: string
): boolean {
  // HTTP routes: search method and path
  if (nodeType === 'http:route') {
    // ... HTTP route logic ...
  }

  // Default: search name field
  const lowerPattern = pattern.toLowerCase();
  const nodeName = (node.name || '').toLowerCase();
  return nodeName.includes(lowerPattern);
}
```

**Change to:**
```typescript
function matchesSearchPattern(
  node: {
    name?: string;
    method?: string;
    path?: string;
    event?: string;
    [key: string]: unknown
  },
  nodeType: string,
  pattern: string
): boolean {
  const lowerPattern = pattern.toLowerCase();

  // HTTP routes: search method and path
  if (nodeType === 'http:route') {
    const method = (node.method || '').toLowerCase();
    const path = (node.path || '').toLowerCase();

    const patternParts = pattern.trim().split(/\s+/);

    if (patternParts.length === 1) {
      const term = patternParts[0].toLowerCase();
      return method === term || path.includes(term);
    } else {
      const methodPattern = patternParts[0].toLowerCase();
      const pathPattern = patternParts.slice(1).join(' ').toLowerCase();
      const methodMatches = method === methodPattern;
      const pathMatches = path.includes(pathPattern);
      return methodMatches && pathMatches;
    }
  }

  // Socket.IO event channels: search name field (standard)
  if (nodeType === 'socketio:event') {
    const nodeName = (node.name || '').toLowerCase();
    return nodeName.includes(lowerPattern);
  }

  // Socket.IO emit/on: search event field
  if (nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
    const eventName = (node.event || '').toLowerCase();
    return eventName.includes(lowerPattern);
  }

  // Default: search name field
  const nodeName = (node.name || '').toLowerCase();
  return nodeName.includes(lowerPattern);
}
```

**Why:**
- `socketio:event`: Search by `name` field (standard pattern)
- `socketio:emit` and `socketio:on`: Search by `event` field
- Maintains existing HTTP route logic
- Falls back to `name` field for other types

---

#### 2.4 Update `NodeInfo` Interface (lines 26-35)

**Current:**
```typescript
interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  method?: string;  // For http:route
  path?: string;    // For http:route
  [key: string]: unknown;
}
```

**Change to:**
```typescript
interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  method?: string;  // For http:route
  path?: string;    // For http:route
  event?: string;   // For socketio:emit, socketio:on, socketio:event
  room?: string;    // For socketio:emit
  namespace?: string; // For socketio:emit
  broadcast?: boolean; // For socketio:emit
  objectName?: string; // For socketio:emit, socketio:on
  handlerName?: string; // For socketio:on
  [key: string]: unknown;
}
```

**Why:** Add Socket.IO-specific fields to NodeInfo interface.

---

#### 2.5 Update `findNodes()` to Include Socket.IO Fields (lines 225-262)

**Current:**
```typescript
async function findNodes(
  backend: RFDBServerBackend,
  type: string | null,
  name: string,
  limit: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const searchTypes = type
    ? [type]
    : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT', 'http:route'];

  for (const nodeType of searchTypes) {
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      const matches = matchesSearchPattern(node, nodeType, name);

      if (matches) {
        const nodeInfo: NodeInfo = {
          id: node.id,
          type: node.type || nodeType,
          name: node.name || '',
          file: node.file || '',
          line: node.line,
        };
        // Include method and path for http:route nodes
        if (nodeType === 'http:route') {
          nodeInfo.method = node.method as string | undefined;
          nodeInfo.path = node.path as string | undefined;
        }
        results.push(nodeInfo);
        if (results.length >= limit) break;
      }
    }
    if (results.length >= limit) break;
  }

  return results;
}
```

**Change to:**
```typescript
async function findNodes(
  backend: RFDBServerBackend,
  type: string | null,
  name: string,
  limit: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const searchTypes = type
    ? [type]
    : [
        'FUNCTION',
        'CLASS',
        'MODULE',
        'VARIABLE',
        'CONSTANT',
        'http:route',
        'socketio:event',
        'socketio:emit',
        'socketio:on'
      ];

  for (const nodeType of searchTypes) {
    for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
      const matches = matchesSearchPattern(node, nodeType, name);

      if (matches) {
        const nodeInfo: NodeInfo = {
          id: node.id,
          type: node.type || nodeType,
          name: node.name || '',
          file: node.file || '',
          line: node.line,
        };

        // Include method and path for http:route nodes
        if (nodeType === 'http:route') {
          nodeInfo.method = node.method as string | undefined;
          nodeInfo.path = node.path as string | undefined;
        }

        // Include event field for Socket.IO nodes
        if (nodeType === 'socketio:event' || nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
          nodeInfo.event = node.event as string | undefined;
        }

        // Include emit-specific fields
        if (nodeType === 'socketio:emit') {
          nodeInfo.room = node.room as string | undefined;
          nodeInfo.namespace = node.namespace as string | undefined;
          nodeInfo.broadcast = node.broadcast as boolean | undefined;
          nodeInfo.objectName = node.objectName as string | undefined;
        }

        // Include listener-specific fields
        if (nodeType === 'socketio:on') {
          nodeInfo.objectName = node.objectName as string | undefined;
          nodeInfo.handlerName = node.handlerName as string | undefined;
        }

        results.push(nodeInfo);
        if (results.length >= limit) break;
      }
    }
    if (results.length >= limit) break;
  }

  return results;
}
```

**Why:** Ensures Socket.IO-specific fields are included in query results.

---

#### 2.6 Update `displayNode()` to Handle Socket.IO (lines 468-475)

**Current:**
```typescript
function displayNode(node: NodeInfo, projectPath: string): void {
  // Special formatting for HTTP routes
  if (node.type === 'http:route' && node.method && node.path) {
    console.log(formatHttpRouteDisplay(node, projectPath));
    return;
  }
  console.log(formatNodeDisplay(node, { projectPath }));
}
```

**Change to:**
```typescript
function displayNode(node: NodeInfo, projectPath: string): void {
  // Special formatting for HTTP routes
  if (node.type === 'http:route' && node.method && node.path) {
    console.log(formatHttpRouteDisplay(node, projectPath));
    return;
  }

  // Special formatting for Socket.IO event channels
  if (node.type === 'socketio:event') {
    console.log(formatSocketEventDisplay(node, projectPath));
    return;
  }

  // Special formatting for Socket.IO emit/on
  if (node.type === 'socketio:emit' || node.type === 'socketio:on') {
    console.log(formatSocketIONodeDisplay(node, projectPath));
    return;
  }

  console.log(formatNodeDisplay(node, { projectPath }));
}
```

---

#### 2.7 Add Display Functions (insert after `formatHttpRouteDisplay()`)

**Insert after line 498:**

```typescript
/**
 * Format Socket.IO event channel for display
 *
 * Output:
 *   [socketio:event] slot:booked
 *     ID: socketio:event#slot:booked
 *     Emitted by: 3 locations
 *     Listened by: 5 locations
 */
function formatSocketEventDisplay(node: NodeInfo, projectPath: string): string {
  const lines: string[] = [];

  // Line 1: [type] event_name
  lines.push(`[${node.type}] ${node.name}`);

  // Line 2: ID
  lines.push(`  ID: ${node.id}`);

  // Lines 3-4: Emitter and listener counts (will be added by caller context)
  // For now, just show the event node itself

  return lines.join('\n');
}

/**
 * Format Socket.IO emit/on for display
 *
 * Output for emit:
 *   [socketio:emit] slot:booked
 *     ID: socketio:emit#slot:booked#server.js#28
 *     Location: server.js:28
 *     Room: gig:123 (if applicable)
 *     Namespace: /admin (if applicable)
 *     Broadcast: true (if applicable)
 *
 * Output for on:
 *   [socketio:on] slot:booked
 *     ID: socketio:on#slot:booked#client.js#13
 *     Location: client.js:13
 *     Handler: anonymous:27
 */
function formatSocketIONodeDisplay(node: NodeInfo, projectPath: string): string {
  const lines: string[] = [];

  // Line 1: [type] event_name
  const eventName = node.event || node.name || 'unknown';
  lines.push(`[${node.type}] ${eventName}`);

  // Line 2: ID
  lines.push(`  ID: ${node.id}`);

  // Line 3: Location (if applicable)
  if (node.file) {
    const loc = formatLocation(node.file, node.line, projectPath);
    if (loc) {
      lines.push(`  Location: ${loc}`);
    }
  }

  // Emit-specific fields
  if (node.type === 'socketio:emit') {
    if (node.room) {
      lines.push(`  Room: ${node.room}`);
    }
    if (node.namespace) {
      lines.push(`  Namespace: ${node.namespace}`);
    }
    if (node.broadcast) {
      lines.push(`  Broadcast: true`);
    }
  }

  // Listener-specific fields
  if (node.type === 'socketio:on' && node.handlerName) {
    lines.push(`  Handler: ${node.handlerName}`);
  }

  return lines.join('\n');
}
```

**Why:**
- Provides clear, formatted output for Socket.IO nodes
- Shows event name prominently
- Includes contextual metadata (room, namespace, broadcast, handler)
- Follows same pattern as HTTP route display

---

#### 2.8 Import `formatLocation` (line 16)

**Current:**
```typescript
import { formatNodeDisplay, formatNodeInline } from '../utils/formatNode.js';
```

**Change to:**
```typescript
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../utils/formatNode.js';
```

**Why:** We use `formatLocation()` in the new display functions.

---

## Part 3: Overview Command Changes

### File: `/packages/cli/src/commands/overview.ts`

#### 3.1 Update Socket.IO Display (lines 64-70)

**Current:**
```typescript
const socketEmit = stats.nodesByType['socketio:emit'] || 0;
const socketOn = stats.nodesByType['socketio:on'] || 0;
// ...
if (socketEmit + socketOn > 0) console.log(`├─ Socket.IO: ${socketEmit} emit, ${socketOn} listeners`);
```

**Change to:**
```typescript
const socketEvents = stats.nodesByType['socketio:event'] || 0;
const socketEmit = stats.nodesByType['socketio:emit'] || 0;
const socketOn = stats.nodesByType['socketio:on'] || 0;
// ...
if (socketEvents > 0) {
  console.log(`├─ Socket.IO: ${socketEvents} events (${socketEmit} emit, ${socketOn} listeners)`);
} else if (socketEmit + socketOn > 0) {
  // Fallback for graphs analyzed before REG-209
  console.log(`├─ Socket.IO: ${socketEmit} emit, ${socketOn} listeners`);
}
```

**Why:**
- Shows event count prominently
- Maintains backward compatibility with graphs analyzed before this change
- Provides context: "events" are the channels, "emit" and "listeners" are the usage points

---

## Part 4: Tests

### File: `/test/scenarios/06-socketio.test.js`

#### 4.1 Add Event Channel Tests (insert after line 151)

**Insert new test section after the "broadcast emits" test:**

```javascript
  describe('Event Channel Creation', () => {
    it('should create socketio:event nodes for unique events', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const eventNodes = allNodes.filter(n => n.type === 'socketio:event');

      // server.js + client.js have events: server:ready, slot:booked, slot:book,
      // message, user:typing, disconnect, connect, message:received, user:joined,
      // user:left, heartbeat, slot:updated
      assert.ok(eventNodes.length >= 10,
        `Expected at least 10 socketio:event nodes, got ${eventNodes.length}`);
    });

    it('should create event node with correct structure', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );

      assert.ok(slotBookedEvent, 'Should have slot:booked event node');
      assert.strictEqual(slotBookedEvent.id, 'socketio:event#slot:booked');
      assert.strictEqual(slotBookedEvent.name, 'slot:booked');
      assert.strictEqual(slotBookedEvent.event, 'slot:booked');
    });

    it('should connect emits to event channels via EMITS_EVENT', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );
      assert.ok(slotBookedEvent);

      const allEdges = await backend.getAllEdges();
      const emitsEventEdges = allEdges.filter(e =>
        e.type === 'EMITS_EVENT' && (e.toId === slotBookedEvent.id || e.dst === slotBookedEvent.id)
      );

      // server.js has multiple slot:booked emits (lines 13, 29, 30)
      assert.ok(emitsEventEdges.length >= 2,
        `Expected at least 2 EMITS_EVENT edges to slot:booked, got ${emitsEventEdges.length}`);
    });

    it('should connect event channels to listeners via LISTENED_BY', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );
      assert.ok(slotBookedEvent);

      const allEdges = await backend.getAllEdges();
      const listenedByEdges = allEdges.filter(e =>
        e.type === 'LISTENED_BY' && (e.fromId === slotBookedEvent.id || e.src === slotBookedEvent.id)
      );

      // client.js has slot:booked listener (line 13)
      // GigView also has slot:booked listener (line 49)
      assert.ok(listenedByEdges.length >= 2,
        `Expected at least 2 LISTENED_BY edges from slot:booked, got ${listenedByEdges.length}`);
    });

    it('should create event nodes even for events with only emitters', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const heartbeatEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name === 'heartbeat'
      );

      // heartbeat is emitted (line 56) but has no listeners in fixture
      assert.ok(heartbeatEvent, 'Should create event node even without listeners');
    });

    it('should deduplicate events across files', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const slotBookedEvents = allNodes.filter(n =>
        n.type === 'socketio:event' && n.name === 'slot:booked'
      );

      // Even though slot:booked appears in both server.js and client.js,
      // there should be only ONE event channel node
      assert.strictEqual(slotBookedEvents.length, 1,
        'Should have exactly one event node per unique event name');
    });

    it('should handle dynamic event names', async () => {
      await orchestrator.run(FIXTURE_PATH);

      const allNodes = await backend.getAllNodes();
      const dynamicEvent = allNodes.find(n =>
        n.type === 'socketio:event' && n.name && n.name.includes('${')
      );

      // socket.join(`user:${socket.userId}`) creates dynamic pattern
      // Should be stored as "user:${...}"
      assert.ok(dynamicEvent, 'Should create event nodes for dynamic patterns');
    });
  });
```

**Why:**
- Tests core functionality: event node creation
- Tests edge connectivity: EMITS_EVENT and LISTENED_BY
- Tests deduplication across files
- Tests edge cases: events with only emitters, dynamic event names
- Uses existing fixture files (server.js, client.js) for realistic scenarios

---

#### 4.2 Update Existing Tests for New Node Count (lines 66-88)

**Current:**
```javascript
it('should detect socket emit events', async () => {
  await orchestrator.run(FIXTURE_PATH);

  const allNodes = await backend.getAllNodes();
  const emitNodes = allNodes.filter(n => n.type === 'socketio:emit');

  assert.ok(emitNodes.length >= 4,
    `Expected at least 4 socketio:emit nodes, got ${emitNodes.length}`);
});
```

**No changes needed** - existing tests still valid because they test specific node types, not totals.

---

## Part 5: Implementation Order

**CRITICAL:** Follow this order to avoid breakage:

### Step 1: SocketIOAnalyzer (Kent + Rob)
1. Add `SocketEventNode` interface
2. Update metadata
3. Add `createEventChannels()` method
4. Modify `execute()` to call `createEventChannels()`

**Test after this step:**
```bash
npm test test/scenarios/06-socketio.test.js
```

Expected: Existing tests pass, new tests fail (not yet added).

---

### Step 2: Add Tests (Kent)
1. Add event channel test section to `06-socketio.test.js`
2. Run tests

**Test after this step:**
```bash
npm test test/scenarios/06-socketio.test.js
```

Expected: All new tests pass.

---

### Step 3: Query Command (Rob)
1. Update `NodeInfo` interface
2. Add Socket.IO types to search list
3. Add type aliases
4. Update `matchesSearchPattern()`
5. Update `findNodes()`
6. Add display functions
7. Update `displayNode()`
8. Import `formatLocation`

**Test after this step:**
```bash
grafema analyze test/fixtures/06-socketio
grafema query "slot:booked"
grafema query "emit slot:booked"
grafema query "on slot:booked"
grafema query "event slot:booked"
```

Expected output:
```
[socketio:event] slot:booked
  ID: socketio:event#slot:booked
```

---

### Step 4: Overview Command (Rob)
1. Update Socket.IO display to show event count

**Test after this step:**
```bash
grafema overview
```

Expected output includes:
```
├─ Socket.IO: 12 events (27 emit, 33 listeners)
```

---

### Step 5: Integration Test (Kent)
1. Run full analysis on fixture
2. Verify all commands work together

```bash
cd test/fixtures/06-socketio
grafema analyze
grafema overview
grafema query "slot:booked"
grafema query "emit heartbeat"
grafema query "on disconnect"
```

---

## Edge Cases and Constraints

### Edge Case 1: Dynamic Event Names

**Scenario:** `socket.emit(\`user:\${userId}\`, data)`

**Behavior:**
- SocketIOAnalyzer already extracts this as `user:${...}`
- Event node created with name `user:${...}`
- Query `grafema query "user:"` matches this pattern

**No special handling needed** - works with existing logic.

---

### Edge Case 2: Events with Only Emitters or Only Listeners

**Scenario:** `io.emit('heartbeat', ...)` but no listener

**Behavior:**
- Event node created: `socketio:event#heartbeat`
- EMITS_EVENT edges created
- No LISTENED_BY edges (empty list)
- Query still finds the event node

**Handled by:** `createEventChannels()` doesn't require both emitters and listeners.

---

### Edge Case 3: Namespace and Room Scoping

**Scenario:** `io.of('/admin').emit('user:joined', ...)` vs `io.emit('user:joined', ...)`

**Current behavior:** Both create same event node `socketio:event#user:joined`

**Is this correct?**
- For v0.1.2: **Yes** - simple implementation
- For future: Create Linear issue for namespace-aware event scoping

**Follow-up issue:** Create REG-XXX for namespace/room-aware event nodes if this becomes a problem.

---

### Edge Case 4: Empty Event Names

**Scenario:** `socket.emit()` called without event argument (syntax error)

**Behavior:**
- `extractStringArg()` returns `"unknown"` or `"dynamic"`
- Event node created with that name
- Not a real event, but won't break analysis

**Acceptable** - garbage in, garbage out.

---

### Edge Case 5: Backward Compatibility

**Scenario:** User has existing graph from before REG-209

**Behavior:**
- `socketio:event` nodes don't exist
- `grafema query "slot:booked"` returns nothing
- User must re-run `grafema analyze`

**Documentation:**
- Add note to CHANGELOG: "Socket.IO events now searchable - re-run analysis to see event nodes"
- Overview command has fallback for old graphs (already implemented in Part 3.1)

---

## Testing Checklist

**Unit tests:**
- [ ] Event nodes created for unique events
- [ ] Event node structure correct (id, type, name, event)
- [ ] EMITS_EVENT edges connect emits to events
- [ ] LISTENED_BY edges connect events to listeners
- [ ] Deduplication across files works
- [ ] Events with only emitters handled
- [ ] Events with only listeners handled
- [ ] Dynamic event names handled

**Integration tests:**
- [ ] `grafema analyze` completes without errors
- [ ] `grafema overview` shows event count
- [ ] `grafema query "slot:booked"` finds event node
- [ ] `grafema query "emit slot:booked"` finds emitters
- [ ] `grafema query "on slot:booked"` finds listeners
- [ ] `grafema query "event slot:booked"` finds event node
- [ ] Display formatting correct for all Socket.IO node types

**Manual tests:**
- [ ] Run on real Socket.IO codebase
- [ ] Verify event names extracted correctly
- [ ] Verify rooms and namespaces shown in emit display
- [ ] Verify handler names shown in listener display

---

## Performance Considerations

**Analysis phase:**
- Before: O(modules) - iterate modules once
- After: O(modules + events) - iterate modules, then create event nodes
- Events count: Typically 10-100 unique events per codebase
- **Impact:** Negligible (< 5% increase in analysis time)

**Query phase:**
- Before: Search emit/on nodes by type, filter by name
- After: Search event nodes by name (indexed)
- **Impact:** Faster - event nodes have `name` field, which is indexed

**Graph size:**
- Before: N emits + M listeners
- After: N emits + M listeners + E events (where E = unique event count)
- Typical codebase: 100 emits, 150 listeners → 250 nodes → 280 nodes (12% increase)
- **Impact:** Negligible

---

## Acceptance Criteria

From user request (001-user-request.md):

- [ ] `grafema query "slot:booked"` finds socketio:event node
- [ ] `grafema query "emit:slotBooked"` finds all emitters (note: pattern is "emit slot:booked")
- [ ] `grafema query "on:slotBooked"` finds all listeners (note: pattern is "on slot:booked")
- [ ] Can trace event flow (implicit via event node showing emitters/listeners)
- [ ] Tests pass

Additional criteria from Don's plan:

- [ ] Event node display shows emitter and listener counts
- [ ] EMITS_EVENT edges connect emits to event channels
- [ ] LISTENED_BY edges connect event channels to listeners
- [ ] Overview shows event count
- [ ] Deduplication works across files

---

## Follow-Up Work (Future Linear Issues)

**Not in scope for REG-209:**

1. **Namespace/room-aware event scoping**
   - Separate `io.of('/admin').emit('user:joined')` from `io.emit('user:joined')`
   - Query: `grafema query "event /admin:user:joined"`
   - Issue priority: v0.2 (if users request it)

2. **Event trace visualization**
   - ASCII diagram showing emit → event → listener flow
   - `grafema trace "slot:booked" --type event --visual`
   - Issue priority: v0.2

3. **Advanced pattern matching**
   - Regex queries: `grafema query "event user:*"`
   - Match all dynamic patterns: `user:${...}` → matches `user:*`
   - Issue priority: v0.3

4. **Event flow in query results**
   - When showing `socketio:event` node, also show connected emitters/listeners
   - Requires additional graph queries in `displayNode()`
   - Issue priority: v0.2

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Event nodes bloat graph | Low | Low | Typical codebases have < 100 unique events |
| Performance regression | Low | Low | Event creation is O(unique events), typically < 100 |
| Breaking existing queries | None | N/A | New node type, no existing queries use it |
| Backward incompatibility | High | Low | Users must re-analyze; documented in CHANGELOG |
| Dynamic events create noise | Medium | Low | Already handled by current `extractStringArg()` logic |

**Overall risk:** Low

---

## Dependencies and Blockers

**Dependencies:**
- SocketIOAnalyzer creates emit/listener nodes correctly ✓ (verified in Don's plan)
- RFDBServerBackend supports `getAllNodes({ type })` ✓ (used in existing tests)
- RFDBServerBackend supports edge queries ✓ (used in query command)

**Blockers:**
- None

**External dependencies:**
- None

---

## Estimated Effort

| Task | Time | Owner |
|------|------|-------|
| SocketIOAnalyzer changes | 2.5 hours | Rob |
| Query command changes | 2 hours | Rob |
| Overview command changes | 15 min | Rob |
| Test writing | 1 hour | Kent |
| Test execution and fixes | 30 min | Kent |
| Integration testing | 30 min | Kent |
| **Total** | **6.5 hours** | |

---

## Conclusion

This implementation follows Don's Option B (Event Channel Nodes) recommendation. It creates `socketio:event` nodes as first-class entities, enabling both search and tracing.

**Key architectural decisions:**

1. **Event nodes are global** - one per unique event name across all files
2. **Two-phase analysis** - emit/listener nodes first, then event channels (cross-file pattern)
3. **Type-aware search** - `socketio:event` searches `name`, emit/on search `event` field
4. **Backward compatible** - users re-analyze to get new nodes, but existing graphs still work

This aligns with Grafema's core thesis: **AI should query the graph, not read code.**

After this change, users can:
- Find all events: `grafema query "slot:booked"`
- Find emitters: `grafema query "emit slot:booked"`
- Find listeners: `grafema query "on slot:booked"`
- Understand event flow without reading code

Ready for Kent and Rob to implement.
