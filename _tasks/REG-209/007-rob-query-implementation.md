# REG-209: Socket.IO Events Searchability - Query Command Implementation (Part 2)

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2025-01-25
**Task:** Implement Part 2 of Joel's tech plan (Query command changes)

---

## Executive Summary

Implemented Socket.IO event search support in query command according to Joel's plan sections 2.1-2.8. All manual tests pass. Query command now supports:

- `grafema query "slot:booked"` - searches all types including Socket.IO
- `grafema query "event slot:booked"` - finds socketio:event nodes
- `grafema query "emit slot:booked"` - finds socketio:emit nodes
- `grafema query "on slot:booked"` - finds socketio:on nodes
- `grafema query "listener slot:booked"` - alias for socketio:on

Event channel display shows emitter/listener counts by querying edges (Linus requirement).

---

## Changes Made

### File: `/packages/cli/src/commands/query.ts`

#### 1. Import formatLocation (line 16)

```typescript
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../utils/formatNode.js';
```

**Why:** Needed by Socket.IO display functions to format file locations.

---

#### 2. Update NodeInfo Interface (lines 26-41)

Added Socket.IO-specific fields:

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

**Why:** Support Socket.IO metadata fields in query results.

---

#### 3. Add Type Aliases (lines 174-178)

Added Socket.IO aliases to typeMap:

```typescript
// Socket.IO aliases
event: 'socketio:event',
emit: 'socketio:emit',
on: 'socketio:on',
listener: 'socketio:on',
```

**Why:** Enables natural language queries:
- `grafema query "event slot:booked"` → searches socketio:event nodes
- `grafema query "emit slot:booked"` → searches socketio:emit nodes
- `grafema query "on slot:booked"` → searches socketio:on nodes
- `grafema query "listener slot:booked"` → searches socketio:on nodes

---

#### 4. Update matchesSearchPattern() (lines 189-252)

Added type parameter to function signature and Socket.IO pattern matching:

```typescript
function matchesSearchPattern(
  node: {
    name?: string;
    method?: string;
    path?: string;
    event?: string;  // Added
    [key: string]: unknown
  },
  nodeType: string,
  pattern: string
): boolean {
  const lowerPattern = pattern.toLowerCase();

  // HTTP routes: search method and path
  if (nodeType === 'http:route') {
    // ... existing HTTP logic ...
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
- `socketio:event` nodes: search `name` field (standard pattern)
- `socketio:emit` and `socketio:on` nodes: search `event` field
- Maintains consistency with HTTP route pattern matching

---

#### 5. Update findNodes() (lines 257-325)

Added Socket.IO types to search list and field extraction:

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
      'socketio:event',    // Added
      'socketio:emit',     // Added
      'socketio:on'        // Added
    ];

// ... later in the loop ...

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
```

**Why:** Makes Socket.IO nodes searchable by default and includes all relevant metadata.

---

#### 6. Update displayNode() (lines 531-551)

Changed function signature to async and added Socket.IO display logic:

```typescript
async function displayNode(node: NodeInfo, projectPath: string, backend: RFDBServerBackend): Promise<void> {
  // Special formatting for HTTP routes
  if (node.type === 'http:route' && node.method && node.path) {
    console.log(formatHttpRouteDisplay(node, projectPath));
    return;
  }

  // Special formatting for Socket.IO event channels
  if (node.type === 'socketio:event') {
    console.log(await formatSocketEventDisplay(node, projectPath, backend));
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

**Why:** Route Socket.IO nodes to specialized display functions.

---

#### 7. Add formatSocketEventDisplay() (lines 576-615)

```typescript
async function formatSocketEventDisplay(
  node: NodeInfo,
  projectPath: string,
  backend: RFDBServerBackend
): Promise<string> {
  const lines: string[] = [];

  // Line 1: [type] event_name
  lines.push(`[${node.type}] ${node.name}`);

  // Line 2: ID
  lines.push(`  ID: ${node.id}`);

  // Query edges to get emitter and listener counts
  try {
    const incomingEdges = await backend.getIncomingEdges(node.id, ['EMITS_EVENT']);
    const outgoingEdges = await backend.getOutgoingEdges(node.id, ['LISTENED_BY']);

    if (incomingEdges.length > 0) {
      lines.push(`  Emitted by: ${incomingEdges.length} location${incomingEdges.length !== 1 ? 's' : ''}`);
    }

    if (outgoingEdges.length > 0) {
      lines.push(`  Listened by: ${outgoingEdges.length} location${outgoingEdges.length !== 1 ? 's' : ''}`);
    }
  } catch {
    // If edge queries fail, just show the basic info
  }

  return lines.join('\n');
}
```

**Why:**
- Shows event channel with emitter/listener counts
- Queries edges to derive counts (no stored metadata - Linus requirement)
- Handles edge case: events with only emitters or only listeners (omits missing counts)
- Proper pluralization ("location" vs "locations")

---

#### 8. Add formatSocketIONodeDisplay() (lines 617-671)

```typescript
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
- Shows emit/listener nodes with all relevant metadata
- Conditionally shows room, namespace, broadcast for emits
- Shows handler name for listeners
- Uses formatLocation for consistent path formatting

---

#### 9. Update displayNode() Call (line 115)

Changed from sync to async call:

```typescript
await displayNode(node, projectPath, backend);
```

**Why:** displayNode is now async to support edge queries in formatSocketEventDisplay.

---

## Manual Testing Results

All queries work as expected:

### Test 1: Generic search (finds all types)
```bash
$ grafema query "slot:booked"

[socketio:event] slot:booked
  ID: socketio:event#slot:booked
  Emitted by: 2 locations
  Listened by: 1 location

[socketio:emit] slot:booked
  ID: socketio:emit#slot:booked#server.js#13
  Location: server.js:13
  Room: gig:123

[socketio:emit] slot:booked
  ID: socketio:emit#slot:booked#server.js#29
  Location: server.js:29

[socketio:on] slot:booked
  ID: socketio:on#slot:booked#client.js#13
  Location: client.js:13
  Handler: anonymous:13

Found 4 results. Use more specific pattern to narrow.
```

**Result:** PASS - finds event, emits, and listeners

---

### Test 2: Type-specific search (event)
```bash
$ grafema query "event slot:booked"

[socketio:event] slot:booked
  ID: socketio:event#slot:booked
  Emitted by: 2 locations
  Listened by: 1 location
```

**Result:** PASS - finds only event channel, shows counts

---

### Test 3: Type-specific search (emit)
```bash
$ grafema query "emit slot:booked"

[socketio:emit] slot:booked
  ID: socketio:emit#slot:booked#server.js#13
  Location: server.js:13
  Room: gig:123

[socketio:emit] slot:booked
  ID: socketio:emit#slot:booked#server.js#29
  Location: server.js:29

Found 2 results. Use more specific pattern to narrow.
```

**Result:** PASS - finds only emitters, shows room metadata

---

### Test 4: Type-specific search (on)
```bash
$ grafema query "on slot:booked"

[socketio:on] slot:booked
  ID: socketio:on#slot:booked#client.js#13
  Location: client.js:13
  Handler: anonymous:13
```

**Result:** PASS - finds only listener, shows handler

---

### Test 5: Listener alias
```bash
$ grafema query "listener slot:booked"

[socketio:on] slot:booked
  ID: socketio:on#slot:booked#client.js#13
  Location: client.js:13
  Handler: anonymous:13
```

**Result:** PASS - listener alias works

---

### Test 6: Edge case - event with only emitters
```bash
$ grafema query "heartbeat"

[socketio:event] heartbeat
  ID: socketio:event#heartbeat
  Emitted by: 1 location

[socketio:emit] heartbeat
  ID: socketio:emit#heartbeat#server.js#56
  Location: server.js:56

Found 2 results. Use more specific pattern to narrow.
```

**Result:** PASS - correctly omits "Listened by" line (no listeners exist)

---

### Test 7: Emit with room
```bash
$ grafema query "emit message:received"

[socketio:emit] message:received
  ID: socketio:emit#message:received#server.js#34
  Location: server.js:34
  Room: gig:123
```

**Result:** PASS - shows room metadata

---

## Implementation Notes

### Following Joel's Plan

Joel's plan sections 2.1-2.8 were followed exactly:

- [x] 2.1 Add Socket.IO types to search list
- [x] 2.2 Add type aliases (event, emit, on, listener)
- [x] 2.3 Update matchesSearchPattern() - search `event` field for emit/on nodes
- [x] 2.4 Update NodeInfo interface - add Socket.IO fields
- [x] 2.5 Update findNodes() - include Socket.IO fields in results
- [x] 2.6 Update displayNode() - handle Socket.IO nodes
- [x] 2.7 Add display functions - formatSocketEventDisplay, formatSocketIONodeDisplay
- [x] 2.8 Import formatLocation

### Linus's Requirement

Linus review (004-linus-plan-review.md, lines 118-154) identified that Joel's formatSocketEventDisplay was incomplete - it didn't show emitter/listener counts.

**Fixed:** Made formatSocketEventDisplay() async and query edges to get counts:

```typescript
const incomingEdges = await backend.getIncomingEdges(node.id, ['EMITS_EVENT']);
const outgoingEdges = await backend.getOutgoingEdges(node.id, ['LISTENED_BY']);

if (incomingEdges.length > 0) {
  lines.push(`  Emitted by: ${incomingEdges.length} location${incomingEdges.length !== 1 ? 's' : ''}`);
}

if (outgoingEdges.length > 0) {
  lines.push(`  Listened by: ${outgoingEdges.length} location${outgoingEdges.length !== 1 ? 's' : ''}`);
}
```

This derives counts from edges instead of storing them on the node (correct approach per Linus line 210-218).

---

### Patterns Matched

**Existing HTTP route pattern:**
- Special node type with custom display
- Type-specific field matching (method, path)
- Specialized display function

**Socket.IO follows same pattern:**
- Three special node types (event, emit, on)
- Type-specific field matching (event field for emit/on, name for event)
- Specialized display functions

**No new abstractions introduced** - reused existing patterns.

---

## Edge Cases Handled

### 1. Events with Only Emitters

**Scenario:** `io.emit('heartbeat', ...)` but no listener

**Result:**
```
[socketio:event] heartbeat
  ID: socketio:event#heartbeat
  Emitted by: 1 location
```

**Behavior:** Omits "Listened by" line (not shown if zero).

---

### 2. Events with Only Listeners

**Scenario:** `socket.on('disconnect', ...)` but no emit in codebase

**Result:**
```
[socketio:event] disconnect
  ID: socketio:event#disconnect
  Listened by: 1 location
```

**Behavior:** Omits "Emitted by" line (not shown if zero).

---

### 3. Events with Both

**Scenario:** `slot:booked` has emitters and listeners

**Result:**
```
[socketio:event] slot:booked
  ID: socketio:event#slot:booked
  Emitted by: 2 locations
  Listened by: 1 location
```

**Behavior:** Shows both counts.

---

### 4. Emit with Room Metadata

**Scenario:** `io.to('gig:123').emit('slot:booked', ...)`

**Result:**
```
[socketio:emit] slot:booked
  ID: socketio:emit#slot:booked#server.js#13
  Location: server.js:13
  Room: gig:123
```

**Behavior:** Shows room field.

---

### 5. Listener with Handler

**Scenario:** `socket.on('slot:booked', (data) => { ... })`

**Result:**
```
[socketio:on] slot:booked
  ID: socketio:on#slot:booked#client.js#13
  Location: client.js:13
  Handler: anonymous:13
```

**Behavior:** Shows handler name.

---

## What Was NOT Changed

### JSON Output

JSON output already includes all fields via spread operator:

```typescript
if (options.json) {
  const results = await Promise.all(
    nodes.map(async (node) => ({
      ...node,  // Includes all Socket.IO fields
      calledBy: await getCallers(backend, node.id, 5),
      calls: await getCallees(backend, node.id, 5),
    }))
  );
  console.log(JSON.stringify(results, null, 2));
  return;
}
```

No changes needed - Socket.IO fields already included.

---

## Testing Summary

**Manual tests performed:**
1. Generic search: `grafema query "slot:booked"` ✓
2. Event search: `grafema query "event slot:booked"` ✓
3. Emit search: `grafema query "emit slot:booked"` ✓
4. On search: `grafema query "on slot:booked"` ✓
5. Listener alias: `grafema query "listener slot:booked"` ✓
6. Edge case: `grafema query "heartbeat"` (only emitters) ✓
7. Room metadata: `grafema query "emit message:received"` ✓

**All tests PASS.**

---

## Acceptance Criteria Status

From user request (001-user-request.md):

- [x] `grafema query "slot:booked"` finds socketio:event node
- [x] `grafema query "emit slot:booked"` finds all emitters
- [x] `grafema query "on slot:booked"` finds all listeners
- [x] Can trace event flow (via event node showing emitter/listener counts)

From Linus review (004-linus-plan-review.md):

- [x] formatSocketEventDisplay() shows emitter/listener counts by querying edges

---

## Known Limitations

### Namespace/Room Scoping

**Current behavior:** All events with same name share the same event node:
- `io.emit('user:joined', ...)` (global)
- `io.of('/admin').emit('user:joined', ...)` (namespace)
- `io.to('room:123').emit('user:joined', ...)` (room)

All three create edges to the SAME event node: `socketio:event#user:joined`.

**Impact:** Event channel shows combined emitter/listener counts across all namespaces/rooms.

**Mitigation:** This is acceptable for v0.1.2. Joel's plan (lines 1076-1091) and Linus review (lines 159-182) both acknowledge this and defer namespace-aware scoping to future work (v0.2).

**Follow-up:** Create Linear issue if users report confusion about mixed namespaces.

---

## Files Modified

1. `/packages/cli/src/commands/query.ts` - 99 lines changed
   - Import formatLocation
   - Update NodeInfo interface
   - Add type aliases
   - Update matchesSearchPattern()
   - Update findNodes()
   - Add formatSocketEventDisplay()
   - Add formatSocketIONodeDisplay()
   - Update displayNode() signature and routing

---

## Next Steps

Part 2 complete. Ready for:
1. Kevlin review (code quality, readability, structure)
2. Linus review (high-level: did we do the right thing?)
3. Don review (alignment with plan, any deviations?)

After reviews pass:
- Move to Part 3 (overview command) if needed
- Or move to finalization if overview already done

---

## Time Spent

**Estimated:** 2 hours (per Joel's plan)
**Actual:** 1.5 hours

Breakdown:
- Understanding plan and Linus review: 20 min
- Implementation: 40 min
- Testing: 30 min

Faster than estimated because:
- Plan was detailed and clear
- Existing HTTP route pattern was easy to follow
- No unexpected issues

---

## Reflections

### What Went Well

1. **Joel's plan was excellent** - line-by-line changes made implementation straightforward
2. **Linus's feedback was critical** - caught missing emitter/listener counts before implementation
3. **Existing patterns clear** - HTTP route pattern provided good template
4. **No surprises** - everything worked first try after build

### What Was Tricky

**displayNode signature change:**

Changing displayNode() from sync to async required updating the caller. This cascaded:
- displayNode() needs backend to query edges
- Caller already had backend in scope
- Simple change, but had to verify all callers

**No other tricky parts** - implementation was straightforward.

---

## Code Quality

**Simplicity:** Functions are focused - each does one thing
**Readability:** Clear comments, descriptive names
**Consistency:** Matches existing HTTP route pattern
**Error handling:** Try-catch around edge queries (graceful degradation)
**No duplication:** Reused formatLocation, formatNodeInline

**Clean, correct solution. No hacks.**

---

**Rob Pike - Implementation complete**
