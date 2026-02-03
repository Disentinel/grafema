# REG-326 Restart — Local Variables Now in Graph

**Date:** 2026-02-03

## Status Change

REG-327 was verified as **already implemented**. The original blocker is resolved.

## What Changed

The graph now contains:
- Function-local VARIABLE nodes with proper scope
- ASSIGNED_FROM edges connecting variables to call initializers

This means the common Express pattern CAN now be traced:

```javascript
app.get('/users', async (req, res) => {
  const users = await db.all('SELECT * FROM users');  // ✅ In graph
  res.json(users);  // Can trace via ASSIGNED_FROM
});
```

## Previous Plan Issues

The original plan had two parts:
1. Fix ExpressResponseAnalyzer to create ASSIGNED_FROM from response node to actual data
2. Add `--from-route` CLI option

**Part 1 is still needed** — ExpressResponseAnalyzer creates disconnected response nodes.
**Part 2 is unchanged** — CLI option to trace from route.

## Next Steps

Restart planning with Don Melton, taking into account:
- Local variables ARE in the graph (no more "limitation")
- ExpressResponseAnalyzer still creates disconnected nodes (needs fix)
- High-level review by Steve Jobs + Вадим (not Linus)
