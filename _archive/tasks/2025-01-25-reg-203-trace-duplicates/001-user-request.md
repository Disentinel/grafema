# User Request

## Linear Issue: REG-203

**Title:** Duplicates in trace output

## Problem

`grafema trace` shows duplicate entries in output:

```
Data sources (where value comes from):
  <- authHeader (VARIABLE)
  <- authHeader (VARIABLE)   ← duplicate
  <- authHeader (VARIABLE)   ← another duplicate
```

## Expected Behavior

Each source should appear only once in trace output.

## Acceptance Criteria

- [ ] Trace output has no duplicates
- [ ] Deduplication by node ID before display
- [ ] Tests pass
