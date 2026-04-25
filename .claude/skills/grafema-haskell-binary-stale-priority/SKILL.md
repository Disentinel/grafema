---
name: grafema-haskell-binary-stale-priority
description: |
  Fix stale Haskell analyzer binaries silently being used by the orchestrator
  even after a successful rebuild. Use when: (1) modified `packages/js-analyzer/`
  or other Haskell analyzer source, ran `scripts/build-native.sh ... cabal install`,
  but a subsequent `grafema analyze` shows old behavior (missing new edges,
  no new node types, etc.), (2) `~/.cabal/bin/grafema-analyzer` has fresh
  timestamp but `grafema analyze` produces output as if the change didn't happen,
  (3) a test verifying new analyzer output passes locally in unit tests but
  fails in end-to-end runs that go through the orchestrator. Root cause: the
  Rust orchestrator's `resolve_binary` checks `~/.grafema/bin/<name>` BEFORE
  `~/.cabal/bin/<name>`, so any stale copy that was once installed there
  (possibly months ago) shadows the fresh `cabal install` output.
author: Claude Code
version: 1.0.0
date: 2026-04-25
---

# Stale Haskell binary in ~/.grafema/bin shadows fresh ~/.cabal/bin

## Problem

The Grafema orchestrator looks for Haskell analyzer binaries in
`~/.grafema/bin/` BEFORE `~/.cabal/bin/`. After running
`scripts/build-native.sh packages/js-analyzer cabal install --install-method=copy --overwrite-policy=always`,
the freshly-built binary lands in `~/.cabal/bin/grafema-analyzer`, but if a
copy was previously placed in `~/.grafema/bin/` (e.g., months ago), the
orchestrator picks that one up instead. End-to-end tests then run with the
old analyzer, and the symptom is that source-level changes appear "to work"
in unit tests but produce zero effect in `grafema analyze` output.

## Context / Trigger Conditions

- Modified Haskell source in `packages/js-analyzer/`, `packages/grafema-resolve/`,
  `packages/python-analyzer/`, or any Haskell analyzer package.
- Ran `scripts/build-native.sh <pkg> cabal install ...` and saw "build succeeded".
- Ran `grafema analyze` (or end-to-end test) and the new behavior is missing —
  no new edge type, no new node type, etc.
- Unit tests against the newly-built `~/.cabal/bin/<binary>` directly DO show
  the new behavior.
- `ls -la ~/.cabal/bin/<binary>` shows fresh mtime, `ls -la ~/.grafema/bin/<binary>`
  shows OLD mtime (the smoking gun).

## Solution

After `cabal install` (or any binary rebuild), force-update `~/.grafema/bin/`
with the fresh binary:

```bash
cp ~/.cabal/bin/grafema-analyzer ~/.grafema/bin/grafema-analyzer
cp ~/.cabal/bin/grafema-resolve ~/.grafema/bin/grafema-resolve
# ...for each affected binary
```

Or symlink once and forget:

```bash
ln -sf ~/.cabal/bin/grafema-analyzer ~/.grafema/bin/grafema-analyzer
```

Permanent fix candidates (not done at the time of writing — see follow-up
task): change `scripts/build-native.sh` to also update `~/.grafema/bin/` after
`cabal install`, OR change the orchestrator's `resolve_binary` to prefer
`~/.cabal/bin/` when its `mtime` is newer than `~/.grafema/bin/`'s, OR refuse
to use `~/.grafema/bin/` when its `.build-hash` doesn't match the source hash.

## Verification

```bash
# 1. Source hash updated
cat packages/js-analyzer/.build-hash

# 2. Both binaries point to recent build
ls -la ~/.cabal/bin/grafema-analyzer ~/.grafema/bin/grafema-analyzer
# Both timestamps should be from the recent build

# 3. End-to-end test
node packages/cli/dist/cli.js analyze
# Verify the new edge type / node type now appears in the graph
```

## Example

During Library Callback Resolver work (April 2026), Change 3 added a
`RECEIVER_CALL` edge to the JS analyzer. `cabal install` succeeded. End-to-end
verification on Grafema's own codebase produced 0 RECEIVER_CALL edges. After
investigation: `~/.cabal/bin/grafema-analyzer` was dated April 25;
`~/.grafema/bin/grafema-analyzer` was dated March 31. After manual `cp`, the
edges appeared correctly and the entire feature pipeline worked end-to-end
on the second `grafema analyze` run.

## Notes

- This issue is more dangerous than a normal stale-build problem because
  unit tests can pass (they invoke the fresh binary directly) while the
  orchestrator silently uses the stale copy.
- The `.build-hash` sidecar in `packages/<pkg>/.build-hash` reflects source
  state but isn't currently checked at runtime against the chosen binary's
  origin — that's a feature gap (see follow-up task).
- A user-friendly heuristic during debugging: if a unit-level Haskell test
  shows X but `grafema analyze` shows ¬X, suspect binary staleness FIRST,
  before suspecting a bug in the orchestrator wiring.

## References

- Build script: `scripts/build-native.sh`
- Binary resolver: `packages/grafema-orchestrator/src/` (search `resolve_binary`)
- Memory note: `MEMORY.md` → "Stale Binary Protection"
