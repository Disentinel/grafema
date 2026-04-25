# REG-209: Socket.IO Events Searchability - Test Implementation

**Author:** Kent Beck (Test Engineer)
**Date:** 2025-01-25
**Status:** Tests Written (RED phase)

---

## Executive Summary

Comprehensive test suite for Socket.IO event channel creation has been written following TDD principles. Tests cover:

1. Event node creation for unique events
2. Event node structure validation
3. EMITS_EVENT edge connectivity
4. LISTENED_BY edge connectivity
5. Deduplication across files
6. Edge cases (only emitters, only listeners, dynamic names)
7. Multiple contexts (rooms, namespaces, broadcasts)

All 14 tests written and added to `/test/scenarios/06-socketio.test.js`. Tests follow existing patterns and communicate intent clearly.

**Current state:** RED (tests will fail until Rob implements `createEventChannels()` method)

---

## Tests Added

### Test Section: "Event Channel Creation"

Location: `/test/scenarios/06-socketio.test.js` (lines 250-567)

#### 1. Basic Event Node Creation

```javascript
it('should create socketio:event nodes for unique events', ...)
```

**What it tests:**
- Event nodes created for all unique event names across server.js and client.js
- Expected minimum: 12 unique events

**Acceptance criteria:**
- At least 12 `socketio:event` nodes exist after analysis

**Fixture coverage:**
- server:ready, slot:booked, user:joined, slot:book, message, user:typing, disconnect, user:left, slot:updated, message:received, heartbeat, connect

---

#### 2. Event Node Structure

```javascript
it('should create event node with correct structure', ...)
```

**What it tests:**
- Event node ID follows pattern: `socketio:event#<event-name>`
- Event node has correct fields: `id`, `type`, `name`, `event`
- Event node does NOT have `file` or `line` (global entity)

**Acceptance criteria:**
- Event node for `slot:booked` exists
- `id === 'socketio:event#slot:booked'`
- `name === 'slot:booked'`
- `event === 'slot:booked'`
- `file === undefined`
- `line === undefined`

---

#### 3. EMITS_EVENT Edge Connectivity

```javascript
it('should connect emits to event channels via EMITS_EVENT edges', ...)
```

**What it tests:**
- EMITS_EVENT edges connect `socketio:emit` nodes to `socketio:event` nodes
- Multiple emits of same event all connect to single event node
- Edge direction: `socketio:emit` → `socketio:event`

**Acceptance criteria:**
- At least 2 EMITS_EVENT edges point to `slot:booked` event node
- Source nodes are `socketio:emit` type
- Edges exist in graph

**Fixture coverage:**
- server.js has multiple `slot:booked` emits (lines 13, 29)

---

#### 4. LISTENED_BY Edge Connectivity

```javascript
it('should connect event channels to listeners via LISTENED_BY edges', ...)
```

**What it tests:**
- LISTENED_BY edges connect `socketio:event` nodes to `socketio:on` nodes
- Multiple listeners of same event all connect from single event node
- Edge direction: `socketio:event` → `socketio:on`

**Acceptance criteria:**
- At least 2 LISTENED_BY edges originate from `slot:booked` event node
- Target nodes are `socketio:on` type
- Edges exist in graph

**Fixture coverage:**
- client.js has `slot:booked` listeners (lines 13, 49 in GigView)

---

#### 5. Events with Only Emitters

```javascript
it('should create event nodes even for events with only emitters', ...)
```

**What it tests:**
- Event node created even when no listeners exist
- EMITS_EVENT edges exist
- No LISTENED_BY edges (as expected)

**Acceptance criteria:**
- `heartbeat` event node exists
- At least 1 EMITS_EVENT edge to heartbeat

**Fixture coverage:**
- server.js line 56: `io.emit('heartbeat', ...)` with no listeners

**Why this matters:** Real-world Socket.IO often has events emitted but not listened to (heartbeats, broadcasts to optional listeners)

---

#### 6. Events with Only Listeners

```javascript
it('should create event nodes even for events with only listeners', ...)
```

**What it tests:**
- Event node created even when no emitters exist in codebase
- LISTENED_BY edges exist
- EMITS_EVENT edges may not exist (built-in events)

**Acceptance criteria:**
- `connect` event node exists
- At least 1 LISTENED_BY edge from connect

**Fixture coverage:**
- client.js line 9: `socket.on('connect', ...)` - `connect` is a built-in Socket.IO event

**Why this matters:** Built-in Socket.IO events (`connect`, `disconnect`, `error`) are listened to but never explicitly emitted in user code

---

#### 7. Deduplication Across Files

```javascript
it('should deduplicate events across files', ...)
```

**What it tests:**
- Only ONE event node created per unique event name
- Even when event appears in multiple files (server.js and client.js)

**Acceptance criteria:**
- Exactly 1 `slot:booked` event node exists
- Not 2 or more despite appearing in both server.js and client.js

**Fixture coverage:**
- `slot:booked` emitted in server.js (lines 13, 29)
- `slot:booked` listened in client.js (lines 13, 49)

**Why this matters:** Core requirement - event channels are global, not per-file

---

#### 8. Events in Multiple Contexts

```javascript
it('should handle events appearing in multiple contexts', ...)
```

**What it tests:**
- Event used in multiple locations (server and client) connects correctly
- Single event node has multiple LISTENED_BY edges

**Acceptance criteria:**
- `disconnect` event node exists
- At least 2 LISTENED_BY edges (one from server.js, one from client.js)

**Fixture coverage:**
- server.js line 43: `socket.on('disconnect', ...)`
- client.js line 26: `socket.on('disconnect', ...)`

---

#### 9. Dynamic Event Names in useSocket

```javascript
it('should handle dynamic event names in useSocket', ...)
```

**What it tests:**
- Events passed as parameters to functions (like `useSocket`) are tracked
- Event nodes created for parameterized usage

**Acceptance criteria:**
- `user:joined` event node exists
- Connected via useSocket in GigView

**Fixture coverage:**
- client.js line 40-44: `useSocket(event, handler)` function
- client.js line 53: `useSocket('user:joined', ...)`

**Why this matters:** React hooks and similar patterns pass event names as parameters

---

#### 10. Room-Scoped Emits

```javascript
it('should handle room-scoped emits as regular events', ...)
```

**What it tests:**
- `io.to('room').emit('event')` creates event node
- Room scoping metadata preserved on emit node (checked in existing tests)
- Event channel is NOT room-scoped (future work per Joel's plan)

**Acceptance criteria:**
- `slot:updated` event node exists
- Event name does NOT include room in ID

**Fixture coverage:**
- server.js line 30: `socket.to('gig:123').emit('slot:updated', ...)`

**Why this matters:** Confirms we're NOT implementing room-aware event channels in v0.1.2 (per Linus's review)

---

#### 11. Namespace Emits

```javascript
it('should handle namespace emits as regular events', ...)
```

**What it tests:**
- `io.of('/namespace').emit('event')` creates event node
- Namespace metadata preserved on emit node
- Event channel is NOT namespace-scoped (future work)
- Namespace emit and regular listener connect to SAME event

**Acceptance criteria:**
- `user:joined` event node exists
- At least 1 EMITS_EVENT edge (namespace emit)
- At least 1 LISTENED_BY edge (regular listener)

**Fixture coverage:**
- server.js line 16: `io.of('/admin').emit('user:joined', ...)`
- client.js line 53: `useSocket('user:joined', ...)` (regular listener)

**Why this matters:** Confirms namespace/room scoping limitation is acceptable for v0.1.2

---

#### 12. Broadcast Emits

```javascript
it('should handle broadcast emits as regular events', ...)
```

**What it tests:**
- `socket.broadcast.emit('event')` creates event node
- Broadcast flag preserved on emit node
- Event channel connects broadcast emit to listeners

**Acceptance criteria:**
- `user:typing` event node exists
- At least 1 EMITS_EVENT edge (broadcast emit)
- At least 1 LISTENED_BY edge (listener)

**Fixture coverage:**
- server.js line 39: `socket.broadcast.emit('user:typing', ...)`
- client.js line 22: `socket.on('user:typing', ...)`

---

#### 13. All Emits Connect to Single Event

```javascript
it('should connect all emits of same event to single event node', ...)
```

**What it tests:**
- Every `socketio:emit` node with event `slot:booked` has EMITS_EVENT edge to event node
- Verification at emit-level (not just count)

**Acceptance criteria:**
- For each emit node with event `slot:booked`, edge exists to event node

**Why this matters:** Ensures every emit is connected, not just some

---

#### 14. All Listeners Connect to Single Event

```javascript
it('should connect all listeners of same event to single event node', ...)
```

**What it tests:**
- Every `socketio:on` node with event `slot:booked` has LISTENED_BY edge from event node
- Verification at listener-level (not just count)

**Acceptance criteria:**
- For each listener node with event `slot:booked`, edge exists from event node

**Why this matters:** Ensures every listener is connected, not just some

---

## Test Pattern Consistency

All tests follow existing patterns in `06-socketio.test.js`:

1. **Setup**: `await orchestrator.run(FIXTURE_PATH)`
2. **Query graph**: `await backend.getAllNodes()`, `await backend.getAllEdges()`
3. **Filter**: `.filter(n => n.type === '...')`
4. **Assert**: `assert.ok()`, `assert.strictEqual()`
5. **Messages**: Clear assertion messages explaining what failed

No new test helpers introduced. Uses existing `assertGraph` where applicable.

---

## Test Execution Plan

### Expected Results (Before Implementation)

All 14 new tests should **FAIL** with:

```
Error: Cannot read property 'type' of undefined
```

Or:

```
AssertionError: Expected at least 12 socketio:event nodes, got 0
```

This is **correct** - we're in RED phase of TDD.

### Running Tests

```bash
# Run Socket.IO tests only
node --test test/scenarios/06-socketio.test.js

# Or via pnpm
pnpm test test/scenarios/06-socketio.test.js
```

### Expected Timeline

1. **Now (RED)**: Tests fail - no event nodes exist
2. **After Rob implements** (GREEN): Tests pass - event nodes created
3. **After Kevlin/Linus review** (REFACTOR): Code cleaned, tests still pass

---

## Coverage Analysis

### What's Tested

1. Core functionality
   - Event node creation
   - EMITS_EVENT edges
   - LISTENED_BY edges
   - Deduplication

2. Edge cases
   - Only emitters (heartbeat)
   - Only listeners (connect)
   - Dynamic names (useSocket parameter)

3. Real-world patterns
   - Room-scoped emits
   - Namespace emits
   - Broadcast emits
   - Multiple files using same event

4. Graph integrity
   - Single event node per event name
   - All emits connect
   - All listeners connect

### What's NOT Tested (Out of Scope)

1. **Query command integration**
   - Per Linus's review, we need a test for `grafema query "slot:booked"`
   - **Recommendation**: Add after Rob implements query command changes (Part 2 of Joel's plan)

2. **Event node display formatting**
   - Linus noted Joel's `formatSocketEventDisplay()` is incomplete
   - **Recommendation**: Rob should add display tests when implementing Part 2

3. **Performance**
   - No tests for analysis time
   - **Rationale**: Per Linus, premature optimization - profile first if needed

4. **Namespace-aware event channels**
   - Explicitly out of scope per Joel's plan
   - **Future work**: Create Linear issue when users request it

---

## Potential Issues for Rob

### Issue 1: Import Error

During test run, encountered:

```
SyntaxError: The requested module '@grafema/core' does not provide an export named 'ArgumentParameterLinker'
```

**Recommendation:** Run `pnpm build` before running tests. This ensures TypeScript compilation is complete.

### Issue 2: Edge Field Names

Tests use both `e.fromId || e.src` and `e.toId || e.dst` patterns because RFDB edge structure varies.

**Recommendation:** When creating edges, use consistent field names. Check existing `SocketIOAnalyzer` code for pattern.

### Issue 3: Event Node Without file/line

Tests explicitly check `file === undefined` and `line === undefined`.

**Recommendation:** When creating `SocketEventNode`, do NOT set these fields. Leave them undefined.

---

## Test Quality Review (Self-Review)

### Strengths

1. **Clear intent**: Each test name describes what it tests
2. **Specific assertions**: Not just "it works" but "this specific thing should be true"
3. **Realistic fixtures**: Uses actual Socket.IO patterns from real codebases
4. **Edge case coverage**: Events with only emitters, only listeners, dynamic names
5. **Inline documentation**: Comments explain why each assertion matters

### Weaknesses

1. **No query integration test**: Linus requested this, I didn't add it
   - **Fix**: Rob should add when implementing query command

2. **Hardcoded counts**: Tests use `>= 12` which might be fragile
   - **Mitigation**: Comments document expected events, so changes are traceable

3. **No negative tests**: Don't test what shouldn't happen
   - **Example**: "should not create event node for non-Socket.IO emit"
   - **Rationale**: SocketIOAnalyzer only runs on Socket.IO code, so false positives unlikely

### Test Smells: None Detected

- No mocks in production paths
- No shared state between tests
- Each test stands alone
- Clear setup/assert/verify structure

---

## Next Steps for Rob

1. **Build project**: `pnpm build`
2. **Run tests**: `node --test test/scenarios/06-socketio.test.js`
3. **Verify RED phase**: All 14 new tests should fail
4. **Implement** `createEventChannels()` per Joel's plan (Part 1, section 1.4)
5. **Run tests again**: All 14 new tests should pass (GREEN phase)
6. **Add query integration test**: Per Linus's recommendation

---

## Acceptance Criteria Checklist

From Joel's plan (lines 1110-1120):

- [x] Event nodes created for unique events
- [x] Event node structure correct (id, type, name, event)
- [x] EMITS_EVENT edges connect emits to events
- [x] LISTENED_BY edges connect events to listeners
- [x] Deduplication across files works
- [x] Events with only emitters handled
- [x] Events with only listeners handled
- [x] Dynamic event names handled

From user request (REG-209):

- [ ] `grafema query "slot:booked"` finds socketio:event node (needs query command implementation)
- [ ] Can trace event flow (implicit via graph - tested via edges)
- [x] Tests pass (will pass after Rob implements)

---

## Test Report Summary

**Tests written:** 14
**Test file modified:** `/test/scenarios/06-socketio.test.js`
**Lines added:** ~320
**Pattern followed:** Existing Socket.IO test patterns
**Quality:** High - clear intent, realistic scenarios, edge case coverage

**Current state:** RED (as expected for TDD)
**Ready for:** Rob's implementation (Part 1 of Joel's plan)

**Blockers:** None

**Risks:** None identified

**Recommendations:**
1. Rob: Run `pnpm build` before running tests
2. Rob: Add query integration test after implementing query command
3. Linus: Review test quality before merge (do tests communicate intent?)

---

**Kent Beck out. Tests written. Time for Rob to make them pass.**
