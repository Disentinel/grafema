---
name: dataflow-gauntlet-methodology
description: |
  Systematic methodology for achieving 100% backward dataflow reachability
  in a new language. Create gauntlet fixture, write trace, diagnose gaps,
  fix analyzer/algorithm, iterate to 100%. Language-agnostic process.
  Use when: (1) adding a new language to Grafema, (2) auditing dataflow
  coverage for existing language, (3) user says "/dataflow-gauntlet".
author: Claude Code
version: 1.0.0
date: 2026-03-12
user_invocable: true
trigger: >
  User says "/dataflow-gauntlet", "dataflow coverage", "trace audit",
  "проверь dataflow", "gauntlet для <language>".
---

# /dataflow-gauntlet -- Backward Dataflow Reachability Audit

## What This Is

A closed-loop methodology for systematically finding and fixing every gap
in Grafema's backward dataflow tracing for a given language. The process
produces a gauntlet fixture (single file, one SEED, N targets covering
every language pattern) and iterates: trace -> diagnose -> fix -> re-trace
until 100% reachability.

**Proven result:** JavaScript gauntlet achieved 119/119 (100%) through
6 iterations (87% -> 97.5% -> 98.3% -> 99.2% -> 100%).

## Process Overview

```
Phase 1: GAUNTLET CREATION      -- build the fixture
Phase 2: TRACE SCRIPT            -- write backward reachability checker
Phase 3: MEASURE                 -- run, get baseline score
Phase 4: DIAGNOSE-FIX LOOP       -- iterate to 100%
Phase 5: REGRESSION CHECK        -- ensure no unit test breakage
```

---

## Phase 1: Gauntlet Fixture Creation

**Goal:** Single file with one SEED constant and N target variables (`v_*`),
each using a distinct language pattern to propagate the SEED value.

### Pattern Categories (adapt per language)

| Category | JS Examples | Patterns |
|----------|-------------|----------|
| **Assignment** | `v_assign_1 = SEED` | Direct, chained, mutation |
| **Functions** | `v_fn_simple = fn(SEED)` | Simple call, default params, rest/spread, arrow, async |
| **Objects** | `v_obj_prop = obj.value` | Property, nested, computed, spread, getter, Object.assign |
| **Arrays** | `v_arr_index = arr[0]` | Index, spread, slice, concat, Array.from/of |
| **Destructuring** | `const {a} = obj` | Object, array, nested, rename, default, rest |
| **Control flow** | `v_cf_ternary = cond ? SEED : other` | Ternary, logical OR/AND/nullish, optional chain, switch |
| **Closures** | `v_closure = makeClosure()()` | Simple, nested, IIFE, complex |
| **Classes** | `v_class_get = inst.method()` | Method, static, getter, private, inheritance, super |
| **Loops** | `v_loop_while` | While, for, for-in, for-of, forEach, map/filter/reduce |
| **Generators** | `v_gen = gen.next().value` | Simple, delegate, multi-yield, infinite, destructured |
| **Promises** | `v_promise_then` | Constructor, .then, Promise.all/race/resolve |
| **Proxy** | `v_proxy_get` | Get trap, set trap, function apply |
| **Error handling** | `v_try_catch` | Try/catch, finally, nested, throw |
| **Collections** | `v_map_get`, `v_set_has` | Map, Set, WeakMap, WeakRef |
| **Modules** | `v_cjs` | CJS exports, ESM (if multi-file) |
| **Misc** | `v_tagged`, `v_symbol` | Tagged template, Symbol, typeof, comma, sequence |

### Naming Convention

```javascript
const SEED = { value: 42 };  // The source -- ALWAYS a CONSTANT named "SEED"

// Category prefix: v_<category>_<variant>
const v_assign_1 = SEED;           // simplest case
const v_fn_simple = identity(SEED); // function call
const v_obj_prop = obj.value;       // property access
```

### Critical Rules

1. **Every `v_*` variable MUST actually receive SEED** -- don't declare without assignment
2. **One pattern per variable** -- don't mix patterns, isolate what's being tested
3. **Include helper functions/classes in the same file** -- the fixture must be self-contained
4. **Add comments explaining what flow path is being tested**

---

## Phase 2: Trace Script

**Goal:** Script that connects to RFDB, finds all `v_*` nodes, and checks
backward reachability to `SEED` through graph edges.

### Core Algorithm: `canReachSeed(nodeId, depth, visited)`

The trace must follow these edge types backward:

```
PRIMARY DATA FLOW:
  ASSIGNED_FROM(receiver, source)  -- receiver := source
  WRITES_TO(lhs_ref, rhs_ref)     -- imperative assignment via reference
  READS_FROM(reference, decl)      -- reference reads a declaration

STRUCTURAL CONTAINMENT:
  HAS_ELEMENT(array, element)      -- array contains element
  HAS_PROPERTY(object, property)   -- object contains property
  HAS_CONSEQUENT / HAS_ALTERNATE   -- ternary/if branches

INTER-PROCEDURAL:
  CALLS(CALL, FUNCTION)            -- call invokes function
  PASSES_ARGUMENT(CALL, arg)       -- call passes argument
  RECEIVES_ARGUMENT(FUNCTION, PARAMETER) -- function receives parameter
  RETURNS(FUNCTION, returnExpr)    -- function returns value
  YIELDS(FUNCTION, yieldExpr)      -- generator yields value

ITERATION:
  ITERATES_OVER(loopVar, iterable) -- loop variable gets values from collection

ERROR HANDLING:
  THROWS(scope, throwExpr)         -- scope throws value

DERIVATION:
  DERIVED_FROM(node, sourceExpr)   -- node derived from expression (callee)
```

### Six Non-Obvious Heuristics (CRITICAL)

These are NOT derivable from edge types alone. Each was discovered
empirically during the JS gauntlet:

#### 1. HAS_ELEMENT / HAS_PROPERTY descent
When tracing backward reaches a CONSTANT/VARIABLE, also follow its
HAS_ELEMENT and HAS_PROPERTY edges. Values inside `[SEED]` or `{v: SEED}`
need descent into structural containment.

#### 2. Receiver mutation heuristic
`arr.push(SEED)`, `map.set(key, SEED)` -- the call mutates the receiver.
Chain: `this_node <- READS_FROM <- REF <- READS_FROM(receiver) <- PA(method) <- DERIVED_FROM <- CALL -> PASSES_ARGUMENT -> SEED`
Mutation methods: `push, unshift, splice, set, add, append, insert, enqueue, prepend`

#### 3. FUNCTION RETURNS/YIELDS following
When backward trace reaches a FUNCTION node directly (not via CALLS),
follow its RETURNS and YIELDS edges to find what value the function produces.

#### 4. Property write propagation
`obj.prop = SEED` creates PA(write). `x = obj.prop` creates PA(read).
These are DIFFERENT nodes. Connect them by resolving the receiver chain
to a common base CONSTANT and matching the property name + intermediate path.

**Algorithm:**
```
resolveReceiverChain(PA) -> {base: CONSTANT_ID, path: "prop1.prop2"}
-- Follow READS_FROM through intermediate PAs and REFs to base CONSTANT
-- Compare: same base + same path + same property name = same property
```

#### 5. Module-level THROWS -> catch PARAMETER
Thrown values flow to catch parameters. Check THROWS on both the declaring
scope AND the MODULE node (for module-level throws).

#### 6. Callback pattern inter-procedural
When a FUNCTION is passed as argument to a CALL, other arguments to that
same CALL may flow into the function's parameters (e.g., `arr.map(fn)` --
array elements flow into fn's first parameter).

### Script Structure

```javascript
// 1. Connect to RFDB
// 2. Collect all v_* CONSTANT and VARIABLE nodes
// 3. Pre-build indexes (e.g., PA write index by property name)
// 4. For each target: canReachSeed(target.id, 0, new Set())
// 5. Report: REACHABLE (N/M) and NOT REACHABLE list
```

### Parameters
- **Depth limit:** 15 (prevents infinite loops, sufficient for all JS patterns)
- **Visited set:** per-target (reset for each v_* variable)

---

## Phase 3: Measure Baseline

```bash
# 1. Analyze the fixture
grafema-orchestrator analyze --config <fixture>/.grafema/config.yaml \
  --socket <fixture>/.grafema/rfdb.sock --force

# 2. Run trace
node /tmp/trace_check.mjs

# Expected output:
# === REACHABLE from SEED (N/M) ===
# v_assign_1, v_assign_2, ...
# === NOT REACHABLE (K/M) ===
# v_cjs, v_loop_forof_results, ...
```

---

## Phase 4: Diagnose-Fix Loop

### For each unreachable variable:

#### Step 1: Write diagnostic script
```javascript
// Find the v_* node, print ALL its edges (incoming + outgoing)
// Trace the chain manually: what nodes exist, what edges connect them
// Identify WHERE the chain breaks
```

#### Step 2: Classify the gap

| Classification | Symptom | Fix location |
|----------------|---------|-------------|
| **Analyzer gap** | Expected edge doesn't exist in graph | Haskell analyzer rules |
| **Trace gap** | Edge exists but trace doesn't follow it | Trace script heuristics |
| **Fixture bug** | Variable never actually receives SEED | Fixture file |
| **Resolution gap** | Edge exists but via unresolved reference | Resolver plugins |

#### Step 3: Fix

- **Analyzer gap:** Edit the relevant `Rules/*.hs` file, rebuild (`cabal clean && cabal build && cabal install --overwrite-policy=always`), re-analyze
- **Trace gap:** Add new edge-following logic to `canReachSeed` or `descendAndCheck`
- **Fixture bug:** Fix the fixture, re-analyze
- **Resolution gap:** Check resolver configuration, may need new resolver

#### Step 4: Batch similar fixes
Search for sibling patterns -- if `for-of` is missing ITERATES_OVER,
check `for-in` too. Don't fix one-by-one when the same root cause affects multiple targets.

### Iteration Order (most impact first)

1. **Infrastructure issues** -- missing imports, broken analysis pipeline
2. **Bulk edge type gaps** -- entire edge type not emitted (e.g., ITERATES_OVER)
3. **Trace algorithm heuristics** -- add new following patterns
4. **Individual pattern fixes** -- specific visitor/rule fixes
5. **Property aliasing / cross-reference** -- hardest, do last

---

## Phase 5: Regression Check

After ALL fixes:

```bash
# Rebuild if analyzer was modified
cabal clean && cabal build && cabal install --overwrite-policy=always

# Rebuild TypeScript packages
pnpm build

# Run unit tests
node --test --test-concurrency=1 'test/unit/*.test.js'

# Re-analyze and re-trace
grafema-orchestrator analyze --config ... --force
node /tmp/trace_check_final.mjs
# Must show: REACHABLE from SEED (N/N)
```

---

## Adapting to a New Language

When adding a new language (Java, Python, Kotlin, etc.):

1. **Study the language's value flow patterns** -- what's analogous to JS destructuring, closures, generators, etc.?
2. **Create a gauntlet fixture** using the pattern categories above, adapted to the language's idioms
3. **Reuse the trace script structure** -- edge types are language-agnostic, only the fixture changes
4. **The six heuristics are universal** -- HAS_ELEMENT descent, receiver mutation, property write aliasing etc. apply to all imperative/OO languages
5. **Language-specific patterns to add:**

| Language | Unique Patterns |
|----------|----------------|
| **Java** | Generics erasure, checked exceptions, method overloading, streams, Optional, records, sealed classes |
| **Python** | Decorators, generators/async generators, `*args/**kwargs`, comprehensions, walrus operator, descriptors |
| **Kotlin** | Extension functions, coroutines, scope functions (let/run/apply), delegation, sealed classes, data classes |
| **Rust** | Ownership/borrowing, pattern matching, traits, impl blocks, closures with move, ? operator |

---

## Reference: JS Gauntlet Progression

```
v6:  104/119 (87.4%)  -- baseline with basic edge following
v7:  116/119 (97.5%)  -- +HAS_ELEMENT, +HAS_PROPERTY, +receiver mutation, +FUNCTION RETURNS
     117/119 (98.3%)  -- +analyzer: for-of ITERATES_OVER edge
     118/119 (99.2%)  -- +fixture: v_continue assignment fix
v8:  119/119 (100.0%) -- +property write propagation
```

## Anti-patterns

- **Don't guess -- diagnose.** Always write a diagnostic script before fixing.
- **Don't patch the trace for analyzer bugs.** If an edge should exist, fix the analyzer.
- **Don't increase depth limit casually.** If 15 isn't enough, you have a cycle or redundant path.
- **Don't skip regression tests.** Analyzer changes can break existing behavior.
- **Don't fix one-by-one when batching is possible.** Search for siblings.
