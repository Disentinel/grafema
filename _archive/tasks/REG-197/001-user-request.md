# REG-197: Type safety: Unify BackendEdge to EdgeRecord

## Problem

Same architectural issue as REG-192, but for edges. `BackendEdge` is a separate type from the domain `EdgeRecord`, causing similar type safety issues.

## Solution

Apply the same pattern from REG-192:

1. Delete `BackendEdge` interface from `RFDBServerBackend.ts`
2. Make edge methods return `EdgeRecord` from `@grafema/types`
3. Remove any `(edge as any)` casts

## Context

Follow-up from REG-192 (node type unification). Same pattern, same fix.
