# REG-209: Socket.IO Events Not Searchable

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-25

## Current State Analysis

### Problem Statement

- `grafema overview` correctly shows "Socket.IO: 27 emit, 33 listeners"
- `grafema query "emit:slotBooked"` and `grafema query "on:slotBooked"` return nothing
- Users cannot search for Socket.IO events despite them being in the graph
- No way to trace event flow from emitters to listeners

### How Socket.IO Events Are Stored

Socket.IO events are stored as two types of nodes:

#### 1. Emit Nodes (`socketio:emit`)

Created by `SocketIOAnalyzer` at line 217-228:

```typescript
{
  id: "socketio:emit#slot:booked#/path/to/file.js#42",
  type: "socketio:emit",
  event: "slot:booked",           // The event name
  room: "gig:123" | null,         // Room if using io.to(room).emit
  namespace: "/admin" | null,      // Namespace if using io.of(ns).emit
  broadcast: true | false,         // If socket.broadcast.emit
  objectName: "socket" | "io",    // Which object emitted
  file: "/path/to/file.js",
  line: 42,
  column: 10
}
```

#### 2. Listener Nodes (`socketio:on`)

Created by `SocketIOAnalyzer` at line 257-266:

```typescript
{
  id: "socketio:on#slot:booked#/path/to/file.js#15",
  type: "socketio:on",
  event: "slot:booked",           // The event name
  objectName: "socket" | "io",    // Which object is listening
  handlerName: "anonymous:27",    // Handler function name
  handlerLine: 27,                // Line where handler defined
  file: "/path/to/file.js",
  line: 15
}
```

#### 3. Room Nodes (`socketio:room`)

Created for `socket.join(room)` calls:

```typescript
{
  id: "socketio:room#gig:123#/path/to/file.js#23",
  type: "socketio:room",
  room: "gig:123",
  objectName: "socket",
  file: "/path/to/file.js",
  line: 23
}
```

### Graph Edges Created

From `SocketIOAnalyzer.ts`:

1. **MODULE → CONTAINS → socketio:emit** (line 298-302)
   - Connects emit nodes to their containing module

2. **MODULE → CONTAINS → socketio:on** (line 309-313)
   - Connects listener nodes to their containing module

3. **socketio:on → LISTENS_TO → FUNCTION** (line 328-332)
   - Connects listener to its handler function (if found)

4. **MODULE → CONTAINS → socketio:room** (line 340-344)
   - Connects room join calls to their module

### What's Missing: Event Name as Searchable Entity

**CRITICAL ARCHITECTURAL GAP:**

The event name (`"slot:booked"`) is stored as a **property** on emit/listener nodes, but there's no way to:

1. Search by event name across all emits and listeners
2. Find all places where a specific event is used
3. Trace flow from emitters to listeners of the same event

**Why this matters:**

The current structure treats each `emit` and each `on` as isolated facts:
- "This file emits slot:booked at line 42"
- "This file listens to slot:booked at line 15"

But there's NO CONNECTION between them. No edge says "these two nodes communicate via the same event."

This violates Grafema's core thesis: **AI should query the graph, not read code.**

If I want to know "what happens when slot:booked is emitted?", I have to:
1. Find all emit nodes (manual search)
2. Filter by event property (not indexed)
3. Find all listener nodes (manual search)
4. Filter by event property (not indexed)
5. Match them manually by string comparison

This is exactly what we'd do by reading code. The graph isn't helping.

## Root Cause Analysis

### Issue 1: Node Types Not in Query Search List

File: `/packages/cli/src/commands/query.ts`, line 233-234

```typescript
const searchTypes = type
  ? [type]
  : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT', 'http:route'];
```

Socket.IO node types (`socketio:emit`, `socketio:on`, `socketio:room`) are not in the default search list.

### Issue 2: Query Only Searches `name` Field

File: `/packages/cli/src/commands/query.ts`, line 217-219

```typescript
const lowerPattern = pattern.toLowerCase();
const nodeName = (node.name || '').toLowerCase();
return nodeName.includes(lowerPattern);
```

The query command only searches the `name` field. But Socket.IO nodes store their meaningful data in the `event` field, which is never queried.

**Example:**

```javascript
// This emit creates a node with:
socket.emit('slot:booked', data);

// Node structure:
{
  id: "socketio:emit#slot:booked#server.js#28",
  type: "socketio:emit",
  name: undefined,              // ← No name field!
  event: "slot:booked"          // ← Actual searchable data here
}
```

This is similar to the HTTP route issue (REG-207), but with one key difference:

- HTTP routes: `method` and `path` are separate searchable fields
- Socket.IO: `event` is the primary searchable field, but there's no semantic grouping

### Issue 3: No Event-Level Connectivity

**This is the deeper architectural issue.**

In HTTP routes, we don't create edges between route handlers because:
- Routes are independent endpoints
- Request/response model is explicit
- No implicit connections needed

But Socket.IO events are **communication channels**. An emit and a listener for the same event ARE connected conceptually, even across files.

Current graph structure:

```
MODULE (server.js) → CONTAINS → socketio:emit (event: "slot:booked")

MODULE (client.js) → CONTAINS → socketio:on (event: "slot:booked")
```

Missing structure:

```
socketio:emit (event: "slot:booked")
    ↓
  [EVENT_CHANNEL: "slot:booked"]  ← Missing!
    ↓
socketio:on (event: "slot:booked")
```

**Why this matters:**

Without event-level nodes, queries like:
- "What listens to this emit?"
- "What emits this event that this listener receives?"
- "Show me all communication paths for slot:booked"

...are impossible without string matching and manual correlation.

## Proposed Solution

### Option A: Query-Only Solution (Minimum Viable)

**Scope:** Make existing nodes searchable without changing graph structure.

1. **Add Socket.IO types to query search list:**
   ```typescript
   const searchTypes = [
     'FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT',
     'http:route', 'socketio:emit', 'socketio:on', 'socketio:room'
   ];
   ```

2. **Add type aliases:**
   ```typescript
   const typeMap = {
     emit: 'socketio:emit',
     on: 'socketio:on',
     listener: 'socketio:on',
     socket: null  // search all socket types
   };
   ```

3. **Extend `matchesSearchPattern()` to search `event` field:**
   ```typescript
   if (nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
     const eventName = (node.event || '').toLowerCase();
     return eventName.includes(pattern);
   }
   ```

4. **Support patterns like:**
   - `grafema query "emit slot:booked"` → find emitters
   - `grafema query "on slot:booked"` → find listeners
   - `grafema query "slot:booked"` → find both (search all types)

**Pros:**
- Simple, follows HTTP route pattern (REG-207)
- No graph structure changes
- Quick to implement

**Cons:**
- No tracing capability
- Manual correlation still needed
- Doesn't fix architectural gap

### Option B: Event Channel Nodes (Recommended)

**Scope:** Create first-class event entities to enable tracing.

#### Changes to `SocketIOAnalyzer`:

1. **Create event channel nodes:**
   ```typescript
   interface EventChannelNode {
     id: string;                    // "socketio:event#slot:booked"
     type: "socketio:event";
     name: "slot:booked";           // ← Searchable by name!
     eventCount: number;            // emit + listener count
   }
   ```

2. **Create edges:**
   ```typescript
   // Emit → Event Channel
   socketio:emit → EMITS_EVENT → socketio:event

   // Event Channel → Listener
   socketio:event → LISTENED_BY → socketio:on
   ```

3. **Deduplication:**
   Event channel nodes are created once per unique event name across entire codebase.

#### Example Graph Structure:

```
MODULE (server.js)
  ↓ CONTAINS
socketio:emit (event: "slot:booked", line: 28)
  ↓ EMITS_EVENT
socketio:event (name: "slot:booked")
  ↓ LISTENED_BY
socketio:on (event: "slot:booked", line: 15)
  ↑ CONTAINS
MODULE (client.js)
```

#### Query Examples:

```bash
# Find the event channel
grafema query "slot:booked"
→ [socketio:event] slot:booked
    Emitted by: 3 locations
    Listened by: 5 locations

# Find specific emitters
grafema query "emit slot:booked"
→ server.js:28  socket.emit('slot:booked', result)
  server.js:42  io.to('gig:123').emit('slot:booked', data)

# Trace the event flow
grafema trace "slot:booked" --type event
→ Emitters:
    server.js:28 (socket.emit in bookSlot function)
    server.js:42 (io.to in notifyGig function)
  Listeners:
    client.js:15 (socket.on handler)
    gigView.js:49 (useSocket hook)
```

**Pros:**
- Enables true event tracing
- Makes events first-class citizens
- Aligns with Grafema's graph-first vision
- Supports advanced queries (room-based, namespace-based)

**Cons:**
- More complex implementation
- Changes graph structure (new node type)
- Requires test updates

### Option C: Hybrid Approach (Pragmatic)

**Phase 1:** Implement Option A (query-only)
- Get basic searchability working now
- No graph changes, low risk

**Phase 2:** Implement Option B (event channels)
- Add tracing capability
- Create new Linear issue for this enhancement

## Recommendation

**I recommend Option B (Event Channel Nodes) for this task.**

**Reasoning:**

1. **User request explicitly asks for tracing:** "show emit→listener flow"
2. **Option A doesn't solve the real problem:** It only makes nodes searchable, but doesn't connect emitters to listeners
3. **This is an architectural fix, not a feature add:** The lack of event-level connectivity is a product gap
4. **Pattern already exists:** We created `net:request` singleton in ExpressAnalyzer for similar reasons
5. **Small scope:** Adding one node type + two edge types is well-defined

**If we do Option A now:**
- Users can find individual emits/listens, but still can't trace flow
- We'll create Linear issue for tracing
- We'll implement Option B later anyway
- Total time: 2x the work

**If we do Option B now:**
- Solves query + tracing in one go
- Graph structure is correct from the start
- No follow-up work needed
- Total time: 1x the work (slightly longer, but complete)

This aligns with Root Cause Policy: **Fix from the roots, not symptoms.**

## Detailed Plan (Option B)

### 1. Modify `SocketIOAnalyzer`

**New node type:** `socketio:event`

```typescript
interface SocketEventNode {
  id: string;           // "socketio:event#slot:booked"
  type: "socketio:event";
  name: string;         // "slot:booked"
  emitCount: number;    // How many emitters
  listenerCount: number; // How many listeners
}
```

**New edges:**
- `EMITS_EVENT`: `socketio:emit` → `socketio:event`
- `LISTENED_BY`: `socketio:event` → `socketio:on`

**Algorithm:**

1. After collecting all emits and listeners in `analyzeModule()`
2. Extract unique event names: `Set<string>`
3. For each unique event:
   - Create `socketio:event` node (or reuse if exists)
   - Create `EMITS_EVENT` edge from each matching emit
   - Create `LISTENED_BY` edge to each matching listener

**Deduplication:**

Event nodes are global (one per event name). Use graph's deduplication logic:

```typescript
const eventNodeId = `socketio:event#${eventName}`;
// Graph backend ensures only one node with this ID exists
await graph.addNode({
  id: eventNodeId,
  type: 'socketio:event',
  name: eventName
});
```

### 2. Update Query Command

File: `/packages/cli/src/commands/query.ts`

**Add to search types:**

```typescript
const searchTypes = [
  'FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT',
  'http:route', 'socketio:event', 'socketio:emit', 'socketio:on'
];
```

**Add type aliases:**

```typescript
const typeMap = {
  // ... existing
  event: 'socketio:event',
  emit: 'socketio:emit',
  on: 'socketio:on',
  listener: 'socketio:on'
};
```

**Update `matchesSearchPattern()`:**

```typescript
// For socketio:event - search name field (standard)
if (nodeType === 'socketio:event') {
  return nodeName.includes(lowerPattern);
}

// For socketio:emit and socketio:on - search event field
if (nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
  const eventName = (node.event || '').toLowerCase();
  return eventName.includes(lowerPattern);
}
```

**Display enhancement:**

When showing `socketio:event` node:

```typescript
if (node.type === 'socketio:event') {
  console.log(`[socketio:event] ${node.name}`);

  // Show emitters
  const emitters = await getEmitters(backend, node.id);
  if (emitters.length > 0) {
    console.log(`  Emitted by (${emitters.length}):`);
    emitters.forEach(e => console.log(`    → ${formatNodeInline(e)}`));
  }

  // Show listeners
  const listeners = await getListeners(backend, node.id);
  if (listeners.length > 0) {
    console.log(`  Listened by (${listeners.length}):`);
    listeners.forEach(l => console.log(`    ← ${formatNodeInline(l)}`));
  }
}
```

**Helper functions:**

```typescript
async function getEmitters(backend, eventNodeId) {
  // Find: socketio:emit → EMITS_EVENT → eventNodeId
  const edges = await backend.getIncomingEdges(eventNodeId, ['EMITS_EVENT']);
  return Promise.all(edges.map(e => backend.getNode(e.src)));
}

async function getListeners(backend, eventNodeId) {
  // Find: eventNodeId → LISTENED_BY → socketio:on
  const edges = await backend.getOutgoingEdges(eventNodeId, ['LISTENED_BY']);
  return Promise.all(edges.map(e => backend.getNode(e.dst)));
}
```

### 3. Update Trace Command (Optional)

File: `/packages/cli/src/commands/trace.ts`

Add support for `--type event`:

```bash
grafema trace "slot:booked" --type event
```

**Logic:**

1. Find `socketio:event` node with matching name
2. Follow `EMITS_EVENT` edges backward to get emitters
3. Follow `LISTENED_BY` edges forward to get listeners
4. Display flow diagram

**This can be a separate subtask if needed.**

### 4. Update Overview Command

File: `/packages/cli/src/commands/overview.ts`

Add event count:

```typescript
const socketEvents = stats.nodesByType['socketio:event'] || 0;

if (socketEvents > 0) {
  console.log(`├─ Socket.IO: ${socketEvents} events (${socketEmit} emit, ${socketOn} listeners)`);
}
```

### 5. Tests

Update `/test/scenarios/06-socketio.test.js`:

**New test cases:**

```javascript
it('should create socketio:event nodes for unique events', async () => {
  await orchestrator.run(FIXTURE_PATH);

  const eventNodes = await backend.getAllNodes({ type: 'socketio:event' });

  // server.js + client.js have events: server:ready, slot:booked, slot:book, message, etc.
  assert.ok(eventNodes.length >= 5, 'Should create event channel nodes');

  const slotBookedEvent = eventNodes.find(n => n.name === 'slot:booked');
  assert.ok(slotBookedEvent, 'Should have slot:booked event node');
});

it('should connect emits to event channels via EMITS_EVENT', async () => {
  await orchestrator.run(FIXTURE_PATH);

  const slotBookedEvent = await backend.getAllNodes({
    type: 'socketio:event',
    name: 'slot:booked'
  });
  assert.ok(slotBookedEvent.length === 1);

  const edges = await backend.getIncomingEdges(slotBookedEvent[0].id, ['EMITS_EVENT']);
  assert.ok(edges.length >= 2, 'Should have multiple emitters connected');
});

it('should connect event channels to listeners via LISTENED_BY', async () => {
  await orchestrator.run(FIXTURE_PATH);

  const slotBookedEvent = await backend.getAllNodes({
    type: 'socketio:event',
    name: 'slot:booked'
  });
  assert.ok(slotBookedEvent.length === 1);

  const edges = await backend.getOutgoingEdges(slotBookedEvent[0].id, ['LISTENED_BY']);
  assert.ok(edges.length >= 1, 'Should have listeners connected');
});
```

## Risks and Considerations

### 1. Performance

**Risk:** Creating event nodes + edges adds graph complexity.

**Mitigation:**
- Event nodes are small (one per unique event name, typically 10-50 in a codebase)
- Edges are O(emits + listeners), same as current CONTAINS edges
- No performance impact on analysis phase

### 2. Dynamic Event Names

**Risk:** Template literals like `socket.emit(\`user:\${id}\`)` create dynamic events.

**Current behavior:** SocketIOAnalyzer stores them as `"user:${...}"` (pattern)

**Solution:** Create event nodes for patterns too:
- `socketio:event#user:${...}` (represents all user:* events)
- Query can match partial patterns: `grafema query "user:"` finds this

### 3. Backward Compatibility

**Risk:** Existing graphs won't have event nodes.

**Mitigation:**
- This is a new feature (v0.1.2-alpha)
- Users need to re-run `grafema analyze` to get event nodes
- No breaking changes to existing queries

### 4. Namespace and Room Awareness

**Risk:** Events in different namespaces/rooms should be separate.

**Solution:** Include namespace/room in event node ID if present:

```typescript
const eventId = namespace
  ? `socketio:event#${namespace}#${eventName}`
  : room
  ? `socketio:event#room:${room}#${eventName}`
  : `socketio:event#${eventName}`;
```

This ensures:
- `/admin` namespace's `user:joined` ≠ global `user:joined`
- Room-based events are scoped correctly

**Initial implementation:** Ignore namespace/room for simplicity. Create issue for enhancement if needed.

## Acceptance Criteria

- [ ] `grafema query "slot:booked"` returns `socketio:event` node
- [ ] `grafema query "emit slot:booked"` returns all emitters
- [ ] `grafema query "on slot:booked"` returns all listeners
- [ ] Event node display shows emitter and listener counts
- [ ] `EMITS_EVENT` edges connect emits to event channels
- [ ] `LISTENED_BY` edges connect event channels to listeners
- [ ] Tests pass for event node creation
- [ ] Tests pass for edge connectivity
- [ ] Overview shows event count

## Dependencies

- SocketIOAnalyzer creates emit/listener nodes correctly ✓ (verified)
- RFDBServerBackend supports queryNodes and edge queries ✓ (verified)
- No RFDB changes needed ✓

## Effort Estimate

**SocketIOAnalyzer changes:**
- Extract unique events: 30 min
- Create event nodes: 30 min
- Create edges: 1 hour
- Handle deduplication: 30 min

**Query command changes:**
- Add types and aliases: 15 min
- Search event field: 30 min
- Display helpers: 1 hour

**Tests:**
- New test cases: 1 hour
- Update existing tests: 30 min

**Total: ~6 hours**

Slightly longer than Option A (~3.5 hours), but delivers complete solution.

## Follow-Up Work (Create Linear Issues)

If we discover during implementation:

1. **REG-XXX: Namespace/room-aware event scoping**
   - Separate events by namespace and room
   - Query: `grafema query "event /admin:user:joined"`

2. **REG-XXX: Event trace visualization**
   - ASCII diagram showing emit → event → listener flow
   - `grafema trace "slot:booked" --type event --visual`

3. **REG-XXX: Dynamic event pattern matching**
   - Advanced pattern queries: `grafema query "event user:*"`
   - Regex support for dynamic events

---

## Conclusion

This is a **product gap** that directly impacts Grafema's value proposition.

Current state: Events exist in the graph, but they're invisible to queries and disconnected from each other.

Desired state: Events are first-class entities that can be queried, traced, and understood as communication channels.

**Option B (Event Channel Nodes) is the RIGHT solution** because:
1. It fixes the root cause (missing connectivity)
2. It aligns with Grafema's graph-first vision
3. It delivers user-requested tracing capability
4. It's only slightly more work than a partial solution

I'm not interested in a hack. Let's do it right.
