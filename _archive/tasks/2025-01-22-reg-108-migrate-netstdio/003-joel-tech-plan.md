# Joel Spolsky's Detailed Technical Implementation Plan

**Task:** REG-108 - Migrate net:stdio to use ExternalStdioNode
**Decision Confirmed:** Fix ExternalStdioNode factory to use `net:stdio` type

---

## Summary of Current State

**ExternalStdioNode.ts (lines 1-37)**
- Type: `EXTERNAL_STDIO` (wrong)
- ID: `EXTERNAL_STDIO:__stdio__` (wrong)
- Missing: `description` field

**GraphBuilder.bufferStdioNodes() (lines 367-394)**
- Type: `net:stdio` (correct)
- ID: `net:stdio#__stdio__` (correct, uses `#` separator)
- Has: `description` field

**ID Format Decision:** Keep the `#` separator from GraphBuilder (`net:stdio#__stdio__`) since:
1. Tests already expect this format
2. Consistent with current GraphBuilder implementation
3. Avoids unnecessary test changes

---

## Implementation Steps

### Step 1: Update ExternalStdioNode.ts

**File:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ExternalStdioNode.ts`

**Changes:**
1. `type: 'EXTERNAL_STDIO'` -> `type: 'net:stdio'`
2. `TYPE = 'EXTERNAL_STDIO'` -> `TYPE = 'net:stdio'`
3. `SINGLETON_ID = 'EXTERNAL_STDIO:__stdio__'` -> `SINGLETON_ID = 'net:stdio#__stdio__'`
4. Add `description?: string` to interface
5. Update REQUIRED to `['name']` (file is builtin)
6. Update OPTIONAL to `['description']`
7. Add `description: 'Standard input/output stream'` to create()
8. Improve error messages in validate()

---

### Step 2: Update GraphBuilder.bufferStdioNodes()

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Changes:**
1. Replace `const stdioId = 'net:stdio#__stdio__'` with `const stdioNode = NodeFactory.createExternalStdio()`
2. Replace `this._createdSingletons.has(stdioId)` with `this._createdSingletons.has(stdioNode.id)`
3. Replace inline object with `stdioNode as unknown as GraphNode`
4. Replace `dst: stdioId` with `dst: stdioNode.id`

---

### Step 3: Update NodeFactory.validate()

**File:** `/Users/vadimr/grafema/packages/core/src/core/NodeFactory.ts`

**Change:** Replace `'EXTERNAL_STDIO': ExternalStdioNode` with `'net:stdio': ExternalStdioNode` in validators map

---

### Step 4: Update DataFlowValidator.ts

**File:** `/Users/vadimr/grafema/packages/core/src/plugins/validation/DataFlowValidator.ts`

**Changes in leafTypes:**
- `'EXTERNAL_STDIO'` -> `'net:stdio'`
- `'EXTERNAL_DATABASE'` -> `'db:query'`
- `'EXTERNAL_NETWORK'` -> `'net:request'`
- `'EXTERNAL_FILESYSTEM'` -> `'fs:operation'`
- `'EVENT_LISTENER'` -> `'event:listener'`

---

### Step 5: PathValidator.ts - No Changes Needed

Already includes both `net:stdio` and `EXTERNAL_STDIO` for backward compatibility.

---

### Step 6: GraphAsserter - No Changes Needed

LEGACY_TYPE_MAP already maps `'EXTERNAL_STDIO': 'net:stdio'`.

---

## Tests - No Changes Required

Tests should pass without modification because:
1. ID format preserved as `net:stdio#__stdio__`
2. Type preserved as `net:stdio`

---

## Implementation Order

1. **First:** Update `ExternalStdioNode.ts`
2. **Second:** Update `NodeFactory.validate()`
3. **Third:** Update `GraphBuilder.bufferStdioNodes()`
4. **Fourth:** Update `DataFlowValidator.ts`

---

## Verification

```bash
node --test test/unit/ClearAndRebuild.test.js
node --test test/scenarios/01-simple-script.test.js
node --test test/scenarios/04-control-flow.test.js
npm test
```
