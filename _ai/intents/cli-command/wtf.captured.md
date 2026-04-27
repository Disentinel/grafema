<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## backward-trace-from-a-variable
```
featureId (CONSTANT) — packages/cli/src/commands/featuresAction.ts:126

"featureId" ← chain (10 nodes reached)

  packages/cli/src/commands/featuresAction.ts
    < backend (PARAMETER)
    => bucket (CONSTANT)
    => beh (CONSTANT)
    => edges (CONSTANT)
    < backend.getIncomingEdges (CALL)
    < id (PROPERTY_ACCESS)
    < getIncomingEdges (PROPERTY_ACCESS)
    => edge (CONSTANT)
    < String (CALL)
    < src (PROPERTY_ACCESS)

Legend: < reads  o- depends on  > calls  => writes  ~>> emits  >x throws  ?| guards  |= governs  {} contains
Use --detail full for complete chain, --detail summary for overview
```

## custom-depth
```
featureId (CONSTANT) — packages/cli/src/commands/featuresAction.ts:126

"featureId" ← chain (10 nodes reached)

  packages/cli/src/commands/featuresAction.ts
    < backend (PARAMETER)
    => bucket (CONSTANT)
    => beh (CONSTANT)
    => edges (CONSTANT)
    < backend.getIncomingEdges (CALL)
    < id (PROPERTY_ACCESS)
    < getIncomingEdges (PROPERTY_ACCESS)
    => edge (CONSTANT)
    < String (CALL)
    < src (PROPERTY_ACCESS)

Legend: < reads  o- depends on  > calls  => writes  ~>> emits  >x throws  ?| guards  |= governs  {} contains
Use --detail full for complete chain, --detail summary for overview
```
