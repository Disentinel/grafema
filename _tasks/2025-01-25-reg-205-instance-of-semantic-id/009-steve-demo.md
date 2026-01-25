# Steve Jobs - Demo Report: REG-205

## Verdict: NOT READY

The fix does NOT work. INSTANCE_OF edges still point to non-existent nodes due to a file path mismatch.

## Demo Steps Executed

### 1. Created Test File

```javascript
// /tmp/demo-class/demo-class.js
class MyService {
  doWork() { return 'working'; }
}
const instance = new MyService();
```

### 2. Ran Analysis

```bash
node packages/cli/dist/cli.js analyze /tmp/demo-class --log-level debug --clear --entrypoint demo-class.js
```

Output confirmed:
- 9 nodes created
- 10 edges created
- Class and instance properly detected

### 3. Inspected Results

**CLASS node (via `grafema get`):**
```json
{
  "id": "demo-class.js->global->CLASS->MyService",
  "type": "CLASS",
  "name": "MyService",
  "file": "demo-class.js"
}
```

**Instance variable node (via `grafema get`):**
```json
{
  "id": "demo-class.js->global->CONSTANT->instance",
  "type": "CONSTANT",
  "edges": {
    "outgoing": [
      {
        "edgeType": "INSTANCE_OF",
        "targetId": "/tmp/demo-class/demo-class.js->global->CLASS->MyService"
      },
      {
        "edgeType": "ASSIGNED_FROM",
        "targetId": "demo-class.js->global->CLASS->MyService"
      }
    ]
  }
}
```

## The Bug: Path Mismatch

| Component | ID Format | File Path Used |
|-----------|-----------|----------------|
| CLASS node | `demo-class.js->global->CLASS->MyService` | basename (`demo-class.js`) |
| INSTANCE_OF edge dst | `/tmp/demo-class/demo-class.js->global->CLASS->MyService` | full path (`/tmp/demo-class/demo-class.js`) |

**The INSTANCE_OF edge points to a node that doesn't exist.**

Verified by trying to get the target:
```
grafema get "/tmp/demo-class/demo-class.js->global->CLASS->MyService"
Node not found
```

## Root Cause

In `GraphBuilder.ts`, the fix applied at line 469:
```typescript
const globalContext = { file: module.file, scopePath: [] as string[] };
classId = computeSemanticId('CLASS', className, globalContext);
```

But `module.file` is the **full path** while CLASS nodes are created using `scopeTracker.getContext()` which provides the **basename**.

The comparison on line 455 also fails:
```typescript
if (decl.file === module.file) {  // decl.file = basename, module.file = full path
  declarationMap.set(decl.name, decl.id);
}
```

So same-file classes are never found, and fallback to external class ID generation kicks in with the wrong path.

## Fix Required

In `GraphBuilder.bufferClassNodes()`:
1. Use `basename(module.file)` instead of `module.file` for comparison on line 455
2. Use `basename(module.file)` instead of `module.file` in `globalContext` on line 469

Or alternatively, normalize all paths consistently across the codebase.

## Impact

This bug means:
- INSTANCE_OF edges are dangling (pointing to non-existent nodes)
- Graph queries for class instantiation relationships will fail
- DI container analysis cannot work correctly
