# User Decisions on Linus Review

**Date:** 2026-01-21

## Decision 1: Type Cast
**Verdict:** FORBIDDEN

No `as unknown as` casts. Fix the type system properly.

## Decision 2: ID Format
**Verdict:** Avoid collisions AND avoid drift

- Must avoid ID collisions (same binding from different sources)
- Must avoid ID drift when adding empty lines (line number changes)
- **Line number is not stable** — can't rely on it for identity

Need a more stable ID that captures semantic identity, not positional identity.

## Decision 3: Auto-detection Location
**Verdict:** ImportNode.create() encapsulates the logic

- `importType` inference should be INSIDE ImportNode.create()
- GraphBuilder should NOT compute it
- One place, one source of truth

## Implications

The ID format needs rethinking. Current options don't work:
- `${file}:IMPORT:${name}:${line}` — drifts when lines change
- `${file}:IMPORT:${source}:${name}:${line}` — still drifts

Need semantic-based ID that doesn't depend on line number for identity.
