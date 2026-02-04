# REG-333: ExpressResponseAnalyzer: Support wrapper functions (asyncHandler, catchAsync)

## Problem

ExpressResponseAnalyzer doesn't detect `res.json()` calls when the route handler is wrapped in a utility function like `asyncHandler` or `catchAsync`.

### Example (not working)

```javascript
// asyncHandler is a common Express pattern
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

router.get('/users/:id', asyncHandler(async (req, res) => {
  const user = await UserModel.findById(req.params.id);
  res.json({ user });  // ❌ Not detected by ExpressResponseAnalyzer
}));
```

### Example (working)

```javascript
router.get('/gigs', async (req, res) => {
  const gigs = await db.all('SELECT * FROM gigs');
  res.json({ gigs });  // ✅ Detected correctly
});
```

## Impact

* `grafema trace --from-route` returns "No response data found"
* ~80% of production Express apps use wrapper patterns
* Jammers backend uses asyncHandler extensively

## Root Cause

ExpressResponseAnalyzer looks for `res.json()` inside the direct callback argument of `router.get/post/etc`. When there's a wrapper function, the actual handler is nested one level deeper.

## Acceptance Criteria

- [ ] Detect common wrapper patterns: `asyncHandler`, `catchAsync`, `wrapAsync`
- [ ] Follow through to inner callback
- [ ] Create RESPONDS_WITH edge correctly
- [ ] Works with Jammers backend

## Technical Notes

Need to:

1. Detect when route callback is a CallExpression (not arrow/function)
2. Check if it's a known wrapper pattern
3. Analyze the first argument of the wrapper as the actual handler

Or more generic: follow any CallExpression that takes a function as first argument.
