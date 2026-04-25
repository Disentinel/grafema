# Uncle Bob PREPARE Review: REG-528

**Date:** 2026-02-20
**Reviewer:** Robert Martin (Uncle Bob)
**Task:** REG-528 — Fix WebSocket connection error handling

## Executive Summary

**SKIP refactoring.** Both files are clean enough for a 35 LOC bug fix. The methods we're modifying are well-scoped and readable.

---

## File 1: grafemaClient.ts

**File size:** 468 lines — **OK**

**Methods to modify:**
- `tryConnect()` (lines 155-171): 17 lines
- `connect()` WebSocket branch (lines 96-121): 26 lines

### File-level: OK

- Single Responsibility: Clear — manages RFDB connection lifecycle
- No duplication observed in target areas
- File length is healthy (468 < 500)

### Method-level: grafemaClient.ts:tryConnect()

**Current signature:**
```typescript
private async tryConnect(): Promise<void>
```

**Line count:** 17 lines
**Nesting depth:** 1 level (if statement inside try/catch)
**Recommendation:** **SKIP**

**Rationale:**
- Linear flow: create client → connect → ping → verify → set state
- Clear error propagation (throws on failure)
- No duplication
- Single purpose: attempt Unix socket connection
- The fix requires adding 1-2 lines for proper error context — well within method's scope

### Method-level: grafemaClient.ts:connect() (WebSocket branch)

**Current signature:**
```typescript
async connect(): Promise<void>
```

**Lines affected:** 96-121 (26 lines in WebSocket branch)
**Nesting depth:** 2 levels (if transport === 'websocket' → try/catch)
**Recommendation:** **SKIP**

**Rationale:**
- Method is 60 lines total, handling 2 transports (WebSocket + Unix socket)
- Each branch is independent and readable
- WebSocket branch (our target): clear flow with existing error handling structure
- The fix improves error message quality, doesn't add complexity
- No duplication between branches (they're fundamentally different)

**Minor observation (NOT blocking):**
- The two transport modes could theoretically be extracted into separate methods
- BUT: each branch is ~25 lines, extraction creates more indirection than value
- Current structure trades slight length for clarity (one place to see both modes)

---

## File 2: extension.ts

**File size:** 771 lines — **CRITICAL (>700)**

**Area to modify:** Connection error handling (lines 168-174)

### File-level: CONCERN (not blocking this task)

**Size:** 771 lines exceeds hard limit (700). File is doing too much:
1. Extension activation/deactivation
2. Command registration (28+ commands)
3. Provider initialization (8+ providers)
4. Cursor tracking logic
5. Search UI implementation (`openSearchNodes`: lines 604-762, 159 lines!)

**Recommendation for THIS task:** SKIP
**Long-term recommendation:** File needs refactoring, but NOT now.

**Why skip for REG-528:**
- Bug fix touches 1 line in a 7-line block
- No coupling to the file's structural issues
- Refactoring a 771-line file = days of work, not 20% of a bug fix

**Post-REG-528 action item:**
Extract at minimum:
- Command registry → `commands.ts` (~400 lines saved)
- Search implementation → `searchNodes.ts` (~160 lines saved)
- Would bring extension.ts to ~200 lines (healthy)

### Method-level: extension.ts:activate()

**Line count:** 157 lines (42-198)
**Recommendation:** **SKIP** (for this task)

**Rationale:**
- Our change: 1 line in the connect() error handler (lines 168-174)
- The 7-line error handling block is clear and isolated
- Adding structured error context doesn't interact with the method's other responsibilities
- Fix is surgical, no ripple effects

---

## Risk Assessment

**Risk:** **LOW**

**Scope:**
- grafemaClient.ts: ~5 lines changed (error message improvements in 2 methods)
- extension.ts: ~1 line changed (add structured error logging)
- Total: ~6 lines modified

**Dependencies:**
- No interface changes
- No new dependencies
- Error messages only (cosmetic for users, helpful for debugging)

**Test impact:**
- Existing tests should pass unchanged
- New tests verify error message structure (not behavior)

---

## Approval

**PROCEED with implementation — no refactoring required.**

The code is clean enough for this fix. Address extension.ts technical debt in a separate task (suggest: REG-530 "Refactor extension.ts command registry").

---

**Signature:** Uncle Bob
**Status:** APPROVED (SKIP refactoring)
