---
name: lean4-theorem-value-access
description: |
  Fix missing theorem proof terms when analyzing Lean 4 environments via importModules.
  Use when: (1) ConstantInfo.value? returns none for theorems despite TheoremVal.value being Expr,
  (2) building code graph / dependency extractor for Lean 4 and getting 0 proof dependency edges,
  (3) Lean 4.30+ project where theorem proofs appear missing from loaded environment,
  (4) analyzing Mathlib or any Lean 4 project and proof terms are empty.
  Root cause: breaking change in Lean 4.30 — value? treats theorems as opaque by default.
author: Claude Code
version: 1.0.0
date: 2026-05-23
---

# Lean 4.30+ Theorem Value Access Breaking Change

## Problem
When loading a Lean 4 environment via `importModules` and iterating over constants,
`ConstantInfo.value?` returns `none` for ALL theorems, even though the proof terms
are present in the `.olean.private` files and loaded into memory.

## Context / Trigger Conditions
- Building a Lean 4 code analyzer, dependency extractor, or proof graph tool
- Using `importModules` to load an environment (e.g., Mathlib)
- `ci.value?` returns `none` for `.thmInfo` constants
- 0 proof dependency edges in output despite theorems existing
- Lean toolchain version is 4.30.0-rc1 or later

## Root Cause

**Breaking change between Lean 4.29.1 and 4.30.0-rc2** in `ConstantInfo.value?`:

```lean
-- Lean 4.29.1 (old behavior):
| .thmInfo  {value, ..}   => some value

-- Lean 4.30.0-rc2 (new behavior):
| .thmInfo  {value, ..}   => if allowOpaque then some value else none
```

In 4.30+, theorems are treated the same as `opaqueInfo` — their values are hidden
unless `allowOpaque := true` is explicitly passed. The default `allowOpaque = false`
causes `value?` to return `none` for all theorems.

The proof terms ARE loaded into memory (`.olean.private` files contain them, and
`importModules` loads at `OLeanLevel.private` by default). The data is there — the
accessor just hides it.

## Solution

**Option A: Pass `allowOpaque := true`** (simplest fix)
```lean
if let some val := ci.value? (allowOpaque := true) then
  -- val is the proof term
```

**Option B: Pattern match directly** (most reliable)
```lean
let valInfo := match ci with
  | .defnInfo v => some (v.value, "VALUE_USES")
  | .thmInfo v  => some (v.value, "PROOF_USES")
  | _           => none
if let some (val, edgeType) := valInfo then
  let deps := val.getUsedConstantsAsSet
  -- process deps
```

Option B is preferred for tools that need to distinguish definition bodies from
proof terms, since `allowOpaque := true` conflates theorems with opaque declarations.

## Verification

```lean
-- This should print true for theorems in Lean 4.30+:
let some ci := env.find? `SomeTheorem | ...
match ci with
| .thmInfo v =>
  eprintln s!"value? default: {ci.value?.isSome}"           -- false
  eprintln s!"value? opaque:  {(ci.value? (allowOpaque := true)).isSome}" -- true
  eprintln s!"direct access:  {v.value.getUsedConstants.size}"  -- >0
| _ => ...
```

## Related Facts

- `.olean` files have THREE levels: `.olean` (public), `.olean.server` (IDE), `.olean.private` (full proofs)
- `importModules` defaults to `OLeanLevel.private` — proofs are loaded
- `Expr.foldConsts` signature: `(e : Expr) (init : α) (f : Name → α → α) : α` — Name is first arg, accumulator second
- `Expr.getUsedConstantsAsSet` returns `NameSet` (= `Std.TreeSet Name`), NOT `NameHashSet` (= `HashSet Name`)
- `NameSet` doesn't have `.fold` — use `for dep in nameSet do` instead
- Mathlib scale: 354K declarations, 11.3M edges (including 4.4M PROOF_USES)

## Notes

- This change aligns with proof irrelevance: for type checking, proof content doesn't
  matter. Tools that DO need proofs (checkers, analyzers, graph builders) must opt in.
- The `value!` function also changed — it panics for theorems unless `allowOpaque := true`.
- `ConstantInfo.getUsedConstantsAsSet` (on ConstantInfo, not Expr) also uses `value?`
  internally, so it will miss proof dependencies too.
