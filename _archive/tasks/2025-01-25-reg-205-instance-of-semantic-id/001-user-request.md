# User Request

## Linear Issue
REG-205: INSTANCE_OF edge points to legacy ID instead of semantic ID

## Problem

INSTANCE_OF edges use inconsistent IDs:

```
socketService has INSTANCE_OF → /path:CLASS:SocketService:0      ← legacy format
But class has ID: socketService.ts->global->CLASS->SocketService  ← semantic format
```

Graph is not connected because edge points to non-existent node ID.

## Impact

* Instance → Class relationship broken
* Queries like "find all instances of SocketService" fail
* Impact analysis for classes doesn't work

## Root Cause

Likely in class instantiation handling — uses old ID format while class nodes use new semantic IDs.

## Acceptance Criteria

- [ ] INSTANCE_OF edges use semantic ID format
- [ ] Edge destination matches actual CLASS node ID
- [ ] Query "instances of class X" works
- [ ] Tests pass
