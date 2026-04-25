# User Request: REG-126

## Linear Issue

**REG-126: Inconsistency - MODULE nodes use hash IDs instead of semantic IDs**

## Summary

From Steve Jobs' demo feedback on REG-123: MODULE nodes use hash-based IDs while all other nodes use semantic IDs. This creates inconsistency.

## Current Behavior

```json
{
  "id": "MODULE:d35ecb7a760522e501e4ac32019175bf0558879058acfc99d543d0e2e37d11df",
  "name": "index.js"
}
```

## Expected Behavior

MODULE nodes should use semantic ID format consistent with other nodes:

```json
{
  "id": "index.js->MODULE",
  "name": "index.js"
}
```

Or similar readable format.

## Context

> "Why? Every other node uses semantic IDs. This inconsistency is jarring."
>
> * Steve Jobs, REG-123 Demo Report

## Related

* REG-123 (Semantic IDs implementation - complete)
