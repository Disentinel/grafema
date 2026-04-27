<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## backward-trace-from-a-variable
```
featureId (CONSTANT) — packages/mcp/src/handlers/behavior-handlers.ts:109

"featureId" ← fan-in from 3 modules (19 nodes reached)

  packages/mcp/src/handlers/behavior-handlers.ts
    < ensureAnalyzed (IMPORT_BINDING)
    < db (PARAMETER)
    => bucket (CONSTANT)
    => beh (CONSTANT)
    => edges (CONSTANT)
    < db.getIncomingEdges (CALL)
    < id (PROPERTY_ACCESS)
    < getIncomingEdges (PROPERTY_ACCESS)
    => edge (CONSTANT)
    < String (CALL)
    < src (PROPERTY_ACCESS)
    < args (PARAMETER)
    => db (CONSTANT)
    < ensureAnalyzed (CALL)

  packages/mcp/src/analysis.ts
    < getOrCreateBackend (IMPORT_BINDING)
    => db (CONSTANT)
    < getOrCreateBackend (CALL)

... (truncated, 6 more lines)
```

## custom-depth
```
featureId (CONSTANT) — packages/mcp/src/handlers/behavior-handlers.ts:109

"featureId" ← fan-in from 3 modules (19 nodes reached)

  packages/mcp/src/handlers/behavior-handlers.ts
    < ensureAnalyzed (IMPORT_BINDING)
    < db (PARAMETER)
    => bucket (CONSTANT)
    => beh (CONSTANT)
    => edges (CONSTANT)
    < db.getIncomingEdges (CALL)
    < id (PROPERTY_ACCESS)
    < getIncomingEdges (PROPERTY_ACCESS)
    => edge (CONSTANT)
    < String (CALL)
    < src (PROPERTY_ACCESS)
    < args (PARAMETER)
    => db (CONSTANT)
    < ensureAnalyzed (CALL)

  packages/mcp/src/analysis.ts
    < getOrCreateBackend (IMPORT_BINDING)
    => db (CONSTANT)
    < getOrCreateBackend (CALL)

... (truncated, 6 more lines)
```
