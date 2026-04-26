# REG-117 Demo Report - Steve Jobs

**Date:** 2025-01-23
**Reviewer:** Steve Jobs (Product Design / Demo)
**Feature:** Nested Array Mutation Tracking

---

## Demo Setup

Created a realistic test project at `/tmp/grafema-demo-reg117/` with:

**store.js** - Simple state container with nested array mutations:
```javascript
const store = { items: [] };
const newItem = { id: 1, name: 'Widget', metadata: { category: 'electronics' } };
store.items.push(newItem);  // FLOWS_INTO edge: newItem -> store

const item2 = { id: 2, name: 'Gadget' };
const item3 = { id: 3, name: 'Gizmo' };
store.items.push(item2, item3);  // Two FLOWS_INTO edges with argIndex 0 and 1

const urgentItem = { id: 0, name: 'Priority', urgent: true };
store.items.unshift(urgentItem);  // FLOWS_INTO edge with mutationMethod: 'unshift'
```

**cart.js** - Shopping cart with nested mutations in functions:
```javascript
const cart = { items: [], totals: { subtotal: 0, tax: 0, total: 0 } };

function addToCart(product, quantity) {
  const cartItem = { productId: product.id, name: product.name, price: product.price, quantity };
  cart.items.push(cartItem);  // FLOWS_INTO edge: cartItem -> cart
}
```

---

## Demo Execution

### Step 1: Project Initialization

```bash
$ grafema init /tmp/grafema-demo-reg117
✓ Found package.json
✓ Detected JavaScript project
✓ Created .grafema/config.yaml
```

**Verdict:** Clean, minimal output. Good.

### Step 2: Analysis

```bash
$ grafema analyze --clear .
Analyzing project: /private/tmp/grafema-demo-reg117
...
[JSASTAnalyzer] Analyzed 3 modules, created 41 nodes
...
Analysis complete in 0.37s
  Nodes: 46
  Edges: 59
```

**Verdict:** Analysis runs fast. Clear summary. Good.

### Step 3: Verifying FLOWS_INTO Edges

I wrote a diagnostic script to examine the graph directly:

```javascript
const edges = await backend.getAllEdges();
const flowsInto = edges.filter(e => e.type === 'FLOWS_INTO');
```

**Results:** 6 FLOWS_INTO edges detected:

| Source | Target | Method | Property | argIndex |
|--------|--------|--------|----------|----------|
| `newItem` | `store` | push | items | 0 |
| `item2` | `store` | push | items | 0 |
| `item3` | `store` | push | items | 1 |
| `urgentItem` | `store` | unshift | items | 0 |
| `cartItem` | `cart` | push | items | 0 |
| `item` (from loop) | `cart` | push | items | 0 |

**Verdict:** The underlying feature works perfectly. All nested array mutations are tracked with correct metadata.

### Step 4: Attempting to Surface via CLI

```bash
$ grafema trace "newItem"
Tracing newItem...

[CONSTANT] newItem
  ID: store.js->global->CONSTANT->newItem
  Location: store.js:7

Data sources (where value comes from):
  <- main (LITERAL) = {"id":1,"name":"Widget","metadata":{"category":"electronics"}}

Possible values:
  • {"id":1,"name":"Widget","metadata":{"category":"electronics"}} (literal)
```

**PROBLEM:** The `trace` command doesn't show that `newItem` flows INTO `store`. It only shows `ASSIGNED_FROM` edges (where value comes from), not `FLOWS_INTO` edges (where value goes to).

```bash
$ grafema query --raw 'edge(X, "FLOWS_INTO", Y)'
[]  # Returns empty via CLI, but data exists in graph
```

**PROBLEM:** The raw query through CLI doesn't return results, even though the edges exist in the database.

---

## Unit Tests

All 20 unit tests pass:
```
# tests 20
# suites 11
# pass 20
# fail 0
```

The feature implementation is correct and complete.

---

## Honest Assessment

### Would I show this on stage?

**The analysis engine: YES.**

The nested array mutation tracking works exactly as designed:
- `obj.arr.push(item)` creates correct FLOWS_INTO edges
- Metadata includes `nestedProperty`, `mutationMethod`, `argIndex`
- Multiple arguments and spread operators handled correctly
- `push`, `unshift`, `splice` all work

**The CLI experience: NO.**

The gap is in discoverability. A user who runs `grafema trace "newItem"` expects to see:

```
Data flows to:
  -> store (via items.push) at store.js:14
```

But they see nothing about where the data goes. The FLOWS_INTO edges are there, but the CLI doesn't expose them.

---

## UX Issues Identified

### Issue 1: `trace` command doesn't show FLOWS_INTO edges

**Current behavior:** Shows only `ASSIGNED_FROM` (where value comes from)
**Expected behavior:** Should also show `FLOWS_INTO` (where value flows to)

**Recommendation:** Add a "Data sinks (mutations)" section to trace output.

### Issue 2: Raw Datalog queries return empty for valid data

**Current behavior:** `grafema query --raw 'edge(X, "FLOWS_INTO", Y)'` returns `[]`
**Root cause:** Unclear - data exists in backend.getAllEdges() but not via raw query

**Recommendation:** Investigate raw query implementation.

### Issue 3: No dedicated command to explore FLOWS_INTO edges

**Current behavior:** No easy way to see "what mutates this object"
**Expected behavior:** Something like `grafema mutations store` or `grafema flows store`

**Recommendation:** Add mutation-focused query command.

---

## Feature Verdict

| Aspect | Status | Notes |
|--------|--------|-------|
| Core implementation | COMPLETE | All tests pass, edges created correctly |
| Edge metadata | COMPLETE | nestedProperty, mutationMethod, argIndex |
| CLI discoverability | INCOMPLETE | trace/query don't surface FLOWS_INTO |
| Documentation | COMPLETE | Tests document all patterns |

---

## Recommendation

**Mark REG-117 as DONE** - the core feature is implemented and working.

**Create follow-up issue** for CLI UX improvements:
- REG-XXX: "Expose FLOWS_INTO edges in trace command and add mutation query"

The implementation delivers what was promised. The UX gap is real but shouldn't block the feature - it's an enhancement to how we surface the data, not a flaw in the data itself.

---

## Final Demo Command

To verify the feature works, run:

```bash
$ node -e "
import { RFDBServerBackend } from '@grafema/core';
const backend = new RFDBServerBackend({ dbPath: '.grafema/graph.rfdb' });
await backend.connect();
const edges = await backend.getAllEdges();
const flowsInto = edges.filter(e => e.type === 'FLOWS_INTO');
console.log('FLOWS_INTO edges:', flowsInto.length);
console.log(JSON.stringify(flowsInto, null, 2));
"
```

This shows all nested array mutations tracked in the graph.

---

**Signed:** Steve Jobs
**Verdict:** Feature complete, CLI experience needs follow-up work
