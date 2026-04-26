# REG-179: Query by Semantic ID - Linus Plan Review

**Date:** 2025-01-24
**Reviewer:** Linus Torvalds (High-level Review)
**Verdict:** APPROVED

## Summary

Both plans are solid. Ship it.

### What's Right

1. **Architecture Decision** - Separate `get` command instead of `--id` flag on `query` is CORRECT
2. **Root Cause Analysis** - CLI gap, not storage problem
3. **Vision Alignment** - AI agents can: trace → copy ID → get → full details
4. **No Tech Debt** - Additive feature

### Scope Decision

- ✅ Add `grafema get <id>` — covered
- ❌ `query --id` flag — rejected (correctly)
- ❌ `trace "X from Y"` — deferred to REG-187
- ✅ Consistent ID behavior — achieved

## Conditions

1. Manual verification: trace → copy ID → get must work
2. ✅ Filed REG-187 for trace scope filtering
3. Update Linear

**SHIP IT.**
