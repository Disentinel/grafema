# Don's Plan: REG-351 Strict Mode False Positives

## Analysis

Ran `grafema analyze --strict` on Jammers codebase (4000+ modules):

**Results:**
- **8 warnings**: CSS parse failures (expected - CSS isn't analyzed)
- **850 fatal errors**: All `STRICT_UNRESOLVED_METHOD` from MethodCallResolver

### Error Categories

1. **Built-in methods on variables** (~600 errors)
   - Array: `.map`, `.filter`, `.push`, `.find`, `.findIndex`, `.indexOf`
   - String: `.split`, `.trim`, `.toLowerCase`, `.replace`, `.toString`
   - Map/Set: `.set`, `.get`, `.delete`
   - Date: `.getTime`, `.getFullYear`
   - Promise: `.then`, `.catch`

2. **Express/HTTP framework** (~150 errors)
   - Response: `res.json`, `res.status`
   - Router: `router.get`, `router.post`, `router.put`, `router.delete`
   - App: `app.use`

3. **Socket.io** (~50 errors)
   - `socket.on`, `socket.emit`, `socket.to`

4. **Browser/DOM APIs** (~30 errors)
   - `localStorage.getItem`, `localStorage.removeItem`
   - `document.createElement`
   - Event: `e.preventDefault`

5. **Fetch API** (~20 errors)
   - `response.json`, `response.text`

6. **Actual user code that should be resolved** (~few)
   - `socketService.verifyAndRemoveOTP` - actual service method
   - `this.getAccessToken` - actual class method

### Root Cause

The `isExternalMethod()` function in `MethodCallResolver.ts` only checks if the **object name** is a known global:

```javascript
const externalObjects = new Set([
  'console', 'Math', 'JSON', ...
]);
return externalObjects.has(object);
```

This misses:
1. **Built-in prototype methods** - When `data.split()` is called, `data` isn't in the set even though `.split` is a built-in String method
2. **Well-known library patterns** - `res.json()` where `res` is an Express response

## Solution

Extend `isExternalMethod()` to also check if the **method name** is a known built-in method that exists on common JavaScript types.

### Approach

1. Add `BUILTIN_METHODS` set containing all common built-in method names from:
   - Array.prototype
   - String.prototype
   - Object.prototype
   - Map.prototype, Set.prototype
   - Promise.prototype
   - Date.prototype

2. Check both object AND method - if either matches, treat as external

3. For library-specific methods (Express, Socket.io), add common patterns:
   - Express response methods: `json`, `status`, `send`, `redirect`
   - Express router methods: `get`, `post`, `put`, `delete`, `use`, `patch`
   - Socket methods: `on`, `emit`, `to`, `join`, `leave`

### What stays as real errors

Methods that don't match any built-in pattern will still error in strict mode:
- User-defined service methods (indicates missing import or definition)
- Methods on classes defined in the project

## Impact

- **Eliminates ~99% of false positives** in strict mode
- **Keeps strict mode useful** for catching real missing methods
- **No changes to non-strict mode** behavior

## Alternative Considered: Config-based Whitelisting

Could allow users to configure external methods in config.yaml:
```yaml
strictMode:
  externalMethods:
    - "res.*"
    - "socket.*"
```

**Rejected because:**
1. Built-in methods should always be external - no config needed
2. Adds complexity for users
3. Most codebases use the same libraries

## Files to Modify

1. `packages/core/src/plugins/enrichment/MethodCallResolver.ts`
   - Expand `isExternalMethod()` function
   - Add comprehensive built-in method lists

## Testing

1. Unit tests for `isExternalMethod()` with new method patterns
2. Re-run strict mode on Jammers - should have ~0 false positives
