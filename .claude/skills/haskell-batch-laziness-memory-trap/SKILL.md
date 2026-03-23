---
name: haskell-batch-laziness-memory-trap
description: |
  Fix increased memory usage when batching sequential Haskell operations into one call.
  Use when: (1) batching N sequential resolveAll/processAll calls into one combined call
  increases memory instead of decreasing it, (2) `show (length result)` or similar spine-forcing
  on a lazy `++` chain holds all sub-results in memory simultaneously, (3) `r <- return $ expr`
  creates thunks that defeat sequential evaluation, (4) `encodeMsgpack . toJSON` creates triple
  in-memory representation (Haskell types -> aeson -> msgpack -> ByteString). Root cause: Haskell
  laziness means "batch" doesn't imply "sequential" — all results coexist as thunks until forced.
author: Claude Code
version: 1.0.0
date: 2026-03-23
---

# Haskell Batch Operation Laziness Trap

## Problem

When converting N sequential IPC round-trips into 1 batched call (e.g., 7 resolver
commands into 1 `resolve-all`), the batched version can use MORE memory than the
sequential version because Haskell's lazy evaluation holds all results simultaneously.

## Context / Trigger Conditions

- Replacing a loop `for cmd in commands: send(cmd); recv(); commit()` with a single
  batched call that runs all operations and returns combined results
- Using `r <- return $ expensiveComputation` to "sequence" pure computations in IO
- Using `show (length (r1 ++ r2 ++ ... ++ rN))` for progress logging
- Using `encodeMsgpack . toJSON` serialization chain (3 in-memory representations)
- Memory increases after "optimization" of sequential to batch

## Solution

### 1. Don't force the full spine for logging

BAD:
```haskell
let result = r1 ++ r2 ++ ... ++ r7
hPutStrLn stderr $ show (length result) ++ " commands"  -- forces ALL spines
writeFrame stdout (encodeMsgpack (ResOk result))
```

GOOD:
```haskell
let result = r1 ++ r2 ++ ... ++ r7
writeFrame stdout (encodeMsgpack (ResOk result))  -- serialize first
hPutStrLn stderr "[done]"  -- log timing only, no count
```

### 2. Use `let` not `return $` for pure computations

BAD:
```haskell
r1 <- return $ Resolver1.resolveAll nodes  -- IO wrapper around thunk
r2 <- return $ Resolver2.resolveAll nodes  -- looks sequential, isn't
```

GOOD:
```haskell
let r1 = Resolver1.resolveAll nodes  -- explicit lazy binding
let r2 = Resolver2.resolveAll nodes  -- no false impression of sequencing
```

Both are lazy, but `let` makes it explicit. `return $` adds IO overhead
and gives a false impression of sequential execution.

### 3. Bypass aeson for hot-path serialization

BAD (triple representation):
```haskell
encodeMsgpack = Binary.encode . aesonToMsgpack . toJSON
-- Creates: [PluginCommand] -> Aeson.Value -> MP.Object -> ByteString
```

GOOD (direct msgpack):
```haskell
pluginCommandToMsgpack :: PluginCommand -> MP.Object
pluginCommandToMsgpack (EmitEdge e) = MP.ObjectMap $ V.fromList [...]
-- Creates: [PluginCommand] -> MP.Object -> ByteString (skip aeson)
```

### 4. Why sequential was actually better for memory

In the OLD sequential path:
```
for each command:
  1. concat contextChunks (700K nodes) -- allocated
  2. build indexes from nodes            -- allocated
  3. run resolver, produce edges         -- allocated
  4. serialize and send                  -- serialized
  5. GC collects concat + indexes + edges -- freed
```
Peak = 1x (nodes + indexes + edges + serialization)

In the NAIVE batch path:
```
1. concat once (700K nodes)              -- allocated, cached
2. r1 = Resolver1.resolveAll (thunk)     -- thunk
3. r2 = Resolver2.resolveAll (thunk)     -- thunk
...
4. length (r1 ++ ... ++ r7)             -- FORCES ALL SPINES
   -- All 7 resolver outputs now in memory simultaneously
5. encodeMsgpack                         -- serializes all at once
```
Peak = 7x edges + serialization overhead

In the CORRECT batch path:
```
1. concat once, cache                    -- allocated once
2. let r1..r7 = lazy thunks             -- no allocation yet
3. encodeMsgpack traverses ++ chain      -- forces one resolver at a time
   -- Each resolver's indexes are local, GC'd after traversal
4. No length forcing                     -- spine consumed incrementally
```
Peak = 1x (nodes + current resolver's indexes + serialization)

## Verification

- Profile with `+RTS -h -RTS` to see heap over time
- Batch path peak should be similar to sequential, not N× higher
- Check that indexes (Map/Set structures) are GC'd between resolvers
  by looking for the sawtooth pattern in the heap profile

## Notes

- Haskell's `++` is right-associative (`infixr 5`), so `r1 ++ (r2 ++ ...)`
  traverses r1 first, then r2, etc. This enables incremental consumption
  IF nothing forces the full spine.
- `toJSON` for lists builds a full `Vector Value` (materializes entire list).
  This is unavoidable without changing the serialization approach.
- GHC's generational GC may delay collection of old-generation data.
  `performGC` can help but is rarely needed if thunks aren't retained.
- The key insight: "batch" in Haskell means "combine lazy structures",
  not "execute sequentially then combine". Sequential execution requires
  explicit `evaluate` or `seq`/`deepseq`.
