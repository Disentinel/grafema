# REG-495: Add onProgress to enrichment plugins (batch 2: connection enrichers)

**Source:** Linear REG-495
**Config:** Single Agent
**Date:** 2026-02-19

## Request

Add `onProgress()` callback to 5 connection/linking enrichment plugins:

1. **ServiceConnectionEnricher** — iterates routes x requests, O(n*m) matching
2. **HTTPConnectionEnricher** — same pattern, routes x requests matching
3. **SocketConnectionEnricher** — iterates socket emitters/listeners
4. **ConfigRoutingMapBuilder** — minimal, iterates config routes
5. **RustFFIEnricher** — iterates NAPI exports x JS calls

Pattern established in REG-497 (batch 1: validation plugins).
