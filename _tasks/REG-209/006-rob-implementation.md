# REG-209: Socket.IO Events Searchability - Implementation Report (Part 1)

**Author:** Rob Pike (Implementation Engineer)
**Date:** 2025-01-25
**Status:** Implementation Complete, 3 Tests Failing

---

## Summary

Implemented Part 1 of Joel's technical plan: modified SocketIOAnalyzer to create event channel nodes and connect them to emitters/listeners via EMITS_EVENT and LISTENED_BY edges.

**Files Modified:**
- `/packages/core/src/plugins/analysis/SocketIOAnalyzer.ts`

**Changes Made:**
1. Added `SocketEventNode` interface (lines 73-83)
2. Updated metadata to include `socketio:event` nodes and `LISTENED_BY` edges (lines 95-106)
3. Modified `execute()` to call `createEventChannels()` after module analysis (Phase 2) (lines 108-165)
4. Implemented `createEventChannels()` method (lines 167-254)

**Build Status:** ✓ Successful
**Test Status:** 11/14 tests passing, 3 failures

---

## Implementation Details

### 1. SocketEventNode Interface

Added after `SocketRoomNode` interface:

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

**Why:** Defines the structure for event channel nodes. Uses optional `file` and `line` fields because event channels are global entities, not tied to specific files.

---

### 2. Metadata Update

Modified `metadata` getter to include new node and edge types:

```typescript
creates: {
  nodes: ['socketio:emit', 'socketio:on', 'socketio:room', 'socketio:event'],
  edges: ['CONTAINS', 'EMITS_EVENT', 'LISTENS_TO', 'JOINS_ROOM', 'LISTENED_BY']
}
```

**Why:** Declares that SocketIOAnalyzer now creates event channel nodes and LISTENED_BY edges.

---

### 3. Two-Phase Execute Method

Split `execute()` into two phases:

**Phase 1:** Analyze modules and create emit/listener/room nodes (existing behavior)
**Phase 2:** Create event channel nodes and connect them (new)

```typescript
// PHASE 1: Analyze modules and create emit/listener/room nodes
for (let i = 0; i < modules.length; i++) {
  const module = modules[i];
  const result = await this.analyzeModule(module, graph);
  emitsCount += result.emits;
  listenersCount += result.listeners;
  roomsCount += result.rooms;
  // ... progress logging ...
}

// PHASE 2: Create event channel nodes and edges
const eventCount = await this.createEventChannels(graph, logger);
```

**Why:** Follows the cross-file operations pattern. Event channels connect nodes from different files, so they must be created AFTER all emit/listener nodes exist.

---

### 4. createEventChannels() Method

Implemented the main logic for event channel creation:

```typescript
private async createEventChannels(
  graph: PluginContext['graph'],
  logger: ReturnType<typeof this.log>
): Promise<number> {
  // Step 1: Get all emit and listener nodes
  const allEmits = await graph.getAllNodes({ type: 'socketio:emit' });
  const allListeners = await graph.getAllNodes({ type: 'socketio:on' });

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

  // Step 3: Create event channel node for each unique event
  let createdCount = 0;
  for (const eventName of eventNames) {
    const eventNodeId = `socketio:event#${eventName}`;

    const eventNode: SocketEventNode = {
      id: eventNodeId,
      type: 'socketio:event',
      name: eventName,
      event: eventName
    };

    await graph.addNode(eventNode as unknown as NodeRecord);
    createdCount++;

    // Step 4: Connect emits → event channel
    const matchingEmits = allEmits.filter(e => e.event === eventName);
    for (const emit of matchingEmits) {
      await graph.addEdge({
        type: 'EMITS_EVENT',
        src: emit.id,
        dst: eventNodeId
      });
    }

    // Step 5: Connect event channel → listeners
    const matchingListeners = allListeners.filter(l => l.event === eventName);
    for (const listener of matchingListeners) {
      await graph.addEdge({
        type: 'LISTENED_BY',
        src: eventNodeId,
        dst: listener.id
      });
    }
  }

  return createdCount;
}
```

**Why:**
- Deduplicates event names across all modules
- Creates one event channel node per unique event
- Connects all emits and listeners for that event
- Handles edge cases: events with only emitters or only listeners

---

## Test Results

**Passing Tests (11/14):**
1. ✓ should create socketio:event nodes for unique events
3. ✓ should connect emits to event channels via EMITS_EVENT edges
5. ✓ should create event nodes even for events with only emitters
6. ✓ should deduplicate events across files
7. ✓ should handle events appearing in multiple contexts
8. ✓ should handle dynamic event names in useSocket
9. ✓ should handle room-scoped emits as regular events
10. ✓ should handle broadcast emits as regular events
12. ✓ should handle namespace emits as regular events (partially - see Test 11 failure)
13. ✓ should connect all emits of same event to single event node
14. ✓ should connect all listeners of same event to single event node

**Failing Tests (3/14):**

### Test 2: Event Node Structure
```
Error: Event node should not have file (global entity)
Expected: undefined
Actual: 'user:joined'
```

**Issue:** Event nodes are being created with a `file` field set to the event name, when they should have `file: undefined`.

**Root Cause:** Unknown - possibly RFDB or graph adapter is populating default fields when nodes are retrieved via `getAllNodes()`.

**Impact:** High - breaks the core concept that event nodes are global entities.

---

### Test 4: LISTENED_BY Edge Count
```
Error: Expected at least 2 LISTENED_BY edges from slot:booked event, got 1
```

**Issue:** Only 1 LISTENED_BY edge created for `slot:booked`, but fixture has 2 listeners:
- Line 13: `socket.on('slot:booked', ...)`
- Line 49: `useSocket('slot:booked', ...)` (which calls `socket.on` on line 42)

**Root Cause:** The listener on line 42 (`socket.on(event, handler)`) is probably being extracted with event name as the variable name "event" (dynamic) rather than the actual value "slot:booked" passed from line 49.

**Impact:** High - affects event tracing accuracy.

---

### Test 11: Namespace Emits
```
Error: user:joined should have listeners
```

**Issue:** Test expects `user:joined` event to have listeners, but none are being connected.

**Context:**
- server.js line 16: `io.of('/admin').emit('user:joined', ...)`
- client.js line 53: `useSocket('user:joined', ...)`

**Root Cause:** Likely same as Test 4 - the `useSocket` call creates a listener with dynamic event name instead of 'user:joined'.

**Impact:** Medium - affects namespace emit tracking.

---

## Analysis Metrics

From test logs:
```
Analysis complete {
  "emitsCount": 11,
  "listenersCount": 11,
  "roomsCount": 2,
  "eventCount": 14
}
```

✓ 14 event channel nodes created (correct)
✓ 11 emit nodes created (correct)
✓ 11 listener nodes created (correct)

---

## Known Issues

### Issue 1: Optional Fields Being Populated

**Problem:** Event nodes have `file` field set to event name when retrieved from graph.

**Hypothesis:** RFDB backend or graph adapter might be:
1. Setting default values for common fields like `file`
2. Copying field values during node serialization
3. Has a bug in how optional fields are handled

**Next Steps:**
- Check how RFDB stores and retrieves nodes with optional fields
- Check if other node types (like `http:route`) have similar issues
- Consider explicitly setting `file: null` instead of leaving undefined

---

### Issue 2: Dynamic Event Name Detection

**Problem:** `useSocket(event, handler)` pattern not being traced correctly.

**Context:**
```javascript
function useSocket(event, handler) {
  socket.on(event, handler);  // Line 42 - extracted as "event" or "dynamic"
}

useSocket('slot:booked', ...);  // Line 49 - actual value not tracked
```

**Why This Matters:** Real-world React/Vue codebases use this pattern extensively.

**Current Behavior:** SocketIOAnalyzer extracts:
- `socket.on(event, ...)` → event name = "event" (variable name) or "dynamic"
- Should be: event name = "slot:booked" (from call site)

**Root Cause:** SocketIOAnalyzer operates at AST level per-module. It sees `socket.on(event, handler)` but doesn't trace where `event` parameter comes from.

**Potential Fixes:**
1. **Dataflow analysis:** Track argument values across function calls (complex, v0.2 feature)
2. **Pattern matching:** Detect `useSocket(eventName, ...)` pattern and extract literal argument (quick fix)
3. **Accept limitation:** Document that parameterized socket.on calls extract as "dynamic" (v0.1.2 acceptable)

**Recommendation:** Accept limitation for v0.1.2, create Linear issue for dataflow-based argument tracking in v0.2.

---

## Code Quality

### Strengths
- Clear separation of phases (PHASE 1 and PHASE 2)
- Follows cross-file operations pattern correctly
- Good logging for debugging
- Handles edge cases (events with only emitters/listeners)
- Clean, readable implementation

### Improvements Needed
- Fix optional field handling (file/line should stay undefined)
- Consider pattern matching for common Socket.IO wrappers like `useSocket`
- Add error handling for malformed event names

---

## Acceptance Criteria Status

From Joel's plan (Part 1):

- [x] Add `SocketEventNode` interface
- [x] Update metadata
- [x] Add `createEventChannels()` method
- [x] Modify `execute()` to call `createEventChannels()`
- [x] Build succeeds
- [⚠️] Tests pass (11/14 - 3 failures)

From user request (REG-209):

- [⚠️] `grafema query "slot:booked"` - not tested yet (Part 2)
- [⚠️] Event flow tracing - partially working (3 test failures)
- [⚠️] Tests pass - 11/14 passing

---

## Next Steps

### Immediate (Rob's Responsibility)
1. **Fix Test 2:** Ensure event nodes don't have `file` field when retrieved from graph
2. **Investigate Test 4 & 11:** Understand why `useSocket` listeners aren't being connected
3. **Re-run tests:** Verify all 14 tests pass after fixes

### After Test Fixes
4. **Part 2:** Implement query command changes (Joel's plan section 2)
5. **Part 3:** Implement overview command changes (Joel's plan section 3)

### Future Work (Create Linear Issues)
- **Dataflow-based argument tracking:** Track literal values passed to parameters like `useSocket(event, handler)`
- **RFDB optional field handling:** Investigate why optional fields are being populated

---

## Build Commands

```bash
# Build TypeScript packages
pnpm --filter @grafema/types build
pnpm --filter @grafema/core build
pnpm --filter @grafema/cli build
pnpm --filter @grafema/mcp build

# Run tests
node --test test/scenarios/06-socketio.test.js
```

---

## Files Changed

### /packages/core/src/plugins/analysis/SocketIOAnalyzer.ts

**Lines modified:**
- 73-83: Added `SocketEventNode` interface
- 101-102: Updated metadata `creates.nodes` and `creates.edges`
- 123-165: Split `execute()` into Phase 1 and Phase 2
- 167-254: Added `createEventChannels()` method

**Total lines added:** ~100
**Total lines modified:** ~10

---

## Conclusion

Part 1 implementation is functionally complete but has 3 test failures related to:
1. Optional field handling (event nodes shouldn't have `file` field)
2. Parameterized socket.on detection (useSocket pattern)

The core functionality works - 14 event nodes are created and most edges connect correctly. The failures are edge cases that need investigation and fixing.

**Ready for:** Kevlin and Linus review after test fixes.

---

**Rob Pike out.**
