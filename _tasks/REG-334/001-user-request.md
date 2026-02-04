# REG-334: Data flow: Trace through Promise callbacks (resolve/reject)

## Problem

Variable tracing stops at `new Promise()` constructor and doesn't follow into the executor callback where the actual data source is.

### Example

```javascript
const gigs = await new Promise((resolve, reject) => {
  database.getDb().all('SELECT * FROM gigs', (err, rows) => {
    if (err) reject(err);
    else resolve(rows);  // ← Data comes from here
  });
});
```

Current trace output:

```
[VARIABLE] gigs
  Data sources:
    <- new Promise() (CONSTRUCTOR_CALL)  ← Stops here
```

Expected:

```
[VARIABLE] gigs
  Data sources:
    <- resolve(rows)
       <- database.getDb().all() callback
          <- SQL: SELECT * FROM gigs
```

## Impact

* Common pattern in Node.js for callback-to-promise conversion
* Blocks tracing to actual database queries
* Jammers backend uses this pattern extensively

## Complexity

This is non-trivial because:

1. Promise executor runs synchronously but resolve/reject are async
2. Need to track that `resolve(x)` means Promise resolves to `x`
3. Multiple resolve/reject paths possible

## Acceptance Criteria

- [ ] Identify Promise executor callback (first arg to `new Promise()`)\
- [ ] Track `resolve(value)` as the Promise resolution value
- [ ] Create data flow edge from resolved value to awaited variable
- [ ] Handle common patterns: callback-based APIs, setTimeout, etc.

## Technical Notes

Approach options:

1. **Simple**: Mark `resolve` argument as Promise value source
2. **Advanced**: Full async dataflow tracking (much harder)

Start with simple approach for MVP.
