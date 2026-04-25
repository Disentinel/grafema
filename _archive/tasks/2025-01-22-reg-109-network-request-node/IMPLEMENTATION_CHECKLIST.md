# REG-109 Implementation Checklist

Quick reference for Rob Pike during implementation.

## Files to Create (3)

- [ ] `/packages/core/src/core/nodes/NetworkRequestNode.ts`
- [ ] `/test/unit/NetworkRequestNode.test.js` 
- [ ] `/test/unit/NetworkRequestNodeMigration.test.js`

## Files to Modify (4)

- [ ] `/packages/core/src/core/nodes/index.ts` (add export)
- [ ] `/packages/core/src/core/NodeFactory.ts` (add factory method + validator)
- [ ] `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (migrate bufferHttpRequests)
- [ ] `/packages/core/src/plugins/analysis/ExpressAnalyzer.ts` (migrate inline creation)

## Implementation Order

1. Phase 1: Create NetworkRequestNode.ts
2. Phase 2: Export from index.ts
3. Phase 3: Update NodeFactory (import, method, validator)
4. **CHECKPOINT:** Write & run unit tests
5. Phase 4: Migrate GraphBuilder (import, replace lines 648-670)
6. Phase 5: Migrate ExpressAnalyzer (import, replace lines 83-90, update line 101)
7. **CHECKPOINT:** Write & run integration tests
8. Phase 6: Run grep verification commands
9. Phase 7: Run full test suite

## Quick Verification Commands

```bash
# Should find NO matches (after migration)
grep -r "type: 'net:request'" packages/core/src/plugins/analysis/

# Should find NO matches (after migration)  
grep -r "'net:request#__network__'" packages/core/src/plugins/analysis/

# Should compile without errors
npm run build

# Should pass
node --test test/unit/NetworkRequestNode.test.js
node --test test/unit/NetworkRequestNodeMigration.test.js

# Should pass (full suite)
npm test
```

## Critical Details

- **Singleton ID:** `'net:request#__network__'`
- **Type:** `'NET_REQUEST'`
- **Import for GraphBuilder:** `../../../core/nodes/NetworkRequestNode.js` (triple `../`)
- **Import for ExpressAnalyzer:** `../../core/nodes/NetworkRequestNode.js` (double `../`)
- **Pattern:** Copy ExternalStdioNode.ts structure exactly

## Definition of Done

- [ ] All 7 files created/modified
- [ ] Zero grep matches for inline creation
- [ ] npm run build passes
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] npm test passes (full suite)

See `003-joel-tech-plan.md` for complete detailed instructions.
