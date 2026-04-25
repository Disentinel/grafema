# Steve Jobs - Demo Report v2

## Demo Setup

Created test file `/tmp/demo-class-v2/demo.js`:
```javascript
// Demo file for REG-205 verification
class MyService {
  doWork() { return 'working'; }
}
const instance = new MyService();
```

## Build & Analysis

```bash
pnpm build  # Build completed successfully
grafema analyze /tmp/demo-class-v2 --entrypoint /tmp/demo-class-v2/demo.js --log-level debug
```

Analysis output confirmed:
- `classesCount:1, instancesCount:1`
- 9 nodes, 10 edges created

## Verification

### Query 1: CLASS node
```bash
grafema query -p /tmp/demo-class-v2 "class MyService" -j
```

Result:
```json
{
  "id": "demo.js->global->CLASS->MyService",
  "type": "CLASS",
  "name": "MyService",
  "file": "demo.js",
  "line": 2
}
```

### Query 2: Instance node with edges
```bash
grafema get -p /tmp/demo-class-v2 "demo.js->global->CONSTANT->instance" -j
```

Result:
```json
{
  "node": {
    "id": "demo.js->global->CONSTANT->instance",
    "type": "CONSTANT",
    "name": "instance"
  },
  "edges": {
    "outgoing": [
      {
        "edgeType": "INSTANCE_OF",
        "targetId": "demo.js->global->CLASS->MyService",
        "targetName": "MyService"
      },
      {
        "edgeType": "ASSIGNED_FROM",
        "targetId": "demo.js->global->CLASS->MyService",
        "targetName": "MyService"
      }
    ]
  }
}
```

## Verification Matrix

| Element | Expected | Actual | Status |
|---------|----------|--------|--------|
| CLASS node ID | `demo.js->global->CLASS->MyService` | `demo.js->global->CLASS->MyService` | PASS |
| INSTANCE_OF target | `demo.js->global->CLASS->MyService` | `demo.js->global->CLASS->MyService` | PASS |
| IDs match | YES | YES | PASS |

## Before vs After

| Version | CLASS node ID | INSTANCE_OF target | Match? |
|---------|---------------|-------------------|--------|
| Before fix | `demo.js->global->CLASS->MyService` | `/tmp/demo-class-v2/demo.js->global->CLASS->MyService` | NO |
| After fix | `demo.js->global->CLASS->MyService` | `demo.js->global->CLASS->MyService` | YES |

## The Experience

The fix is elegant. When you query for instances of a class:

1. The CLASS node uses basename-based semantic ID
2. The INSTANCE_OF edge points to that same ID
3. Graph traversal works seamlessly

This is how it should have been from the start. No full paths leaking into semantic IDs. Clean, consistent, queryable.

---

## Verdict: READY TO SHIP

The fix works exactly as intended. The INSTANCE_OF edge now correctly targets the CLASS node using the same basename-based semantic ID format. Graph consistency is restored.
