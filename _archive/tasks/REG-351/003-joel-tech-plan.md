# Joel's Technical Plan: REG-351

## Implementation Details

### File: `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

#### Change 1: Add Built-in Method Constants

Add at module level, after imports:

```typescript
/**
 * Built-in JavaScript prototype methods that should never error in strict mode.
 * These exist on primitive types and common objects.
 */
const BUILTIN_PROTOTYPE_METHODS = new Set([
  // Array.prototype
  'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find',
  'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop',
  'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some',
  'sort', 'splice', 'toLocaleString', 'toReversed', 'toSorted', 'toSpliced',
  'toString', 'unshift', 'values', 'with', 'at',

  // String.prototype
  'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'localeCompare',
  'match', 'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat',
  'replace', 'replaceAll', 'search', 'split', 'startsWith', 'substring',
  'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase',
  'trim', 'trimEnd', 'trimStart',

  // Object.prototype (commonly called on objects)
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'valueOf',

  // Number.prototype
  'toExponential', 'toFixed', 'toPrecision',

  // Date.prototype
  'getDate', 'getDay', 'getFullYear', 'getHours', 'getMilliseconds',
  'getMinutes', 'getMonth', 'getSeconds', 'getTime', 'getTimezoneOffset',
  'getUTCDate', 'getUTCDay', 'getUTCFullYear', 'getUTCHours',
  'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth', 'getUTCSeconds',
  'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes',
  'setMonth', 'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear',
  'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth',
  'setUTCSeconds', 'toDateString', 'toISOString', 'toJSON',
  'toLocaleDateString', 'toLocaleTimeString', 'toTimeString', 'toUTCString',

  // Map.prototype
  'clear', 'delete', 'get', 'has', 'set', 'size',

  // Set.prototype (same as Map + add)
  'add',

  // Promise.prototype
  'then', 'catch', 'finally',

  // Function.prototype
  'apply', 'bind', 'call',

  // RegExp.prototype
  'exec', 'test',

  // Error.prototype (commonly accessed)
  'message', 'name', 'stack',
]);

/**
 * Common library method patterns that should be treated as external.
 * These are methods from well-known npm packages.
 */
const COMMON_LIBRARY_METHODS = new Set([
  // Express/HTTP response
  'json', 'status', 'send', 'redirect', 'render', 'sendFile', 'sendStatus',
  'type', 'format', 'attachment', 'download', 'end', 'cookie', 'clearCookie',
  'location', 'links', 'jsonp', 'vary', 'append', 'header', 'setHeader',

  // Express router/app
  'use', 'route', 'param', 'all', 'listen',

  // HTTP methods (router.get, router.post, etc.)
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head',

  // Socket.io
  'on', 'emit', 'to', 'in', 'join', 'leave', 'disconnect', 'broadcast',
  'once', 'off', 'removeListener', 'removeAllListeners',

  // EventEmitter
  'addListener', 'prependListener', 'prependOnceListener', 'listeners',
  'listenerCount', 'eventNames', 'rawListeners', 'setMaxListeners',
  'getMaxListeners',

  // Fetch API / Response
  'text', 'blob', 'arrayBuffer', 'formData', 'clone', 'ok', 'redirected',

  // Node.js streams
  'pipe', 'unpipe', 'read', 'write', 'pause', 'resume', 'destroy', 'cork',
  'uncork', 'setEncoding', 'setDefaultEncoding',

  // Axios
  'request', 'interceptors',

  // DOM
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'querySelector',
  'querySelectorAll', 'getElementById', 'getElementsByClassName',
  'getElementsByTagName', 'createElement', 'createTextNode', 'appendChild',
  'removeChild', 'insertBefore', 'replaceChild', 'cloneNode', 'getAttribute',
  'setAttribute', 'removeAttribute', 'hasAttribute', 'classList', 'focus',
  'blur', 'click', 'submit', 'reset', 'preventDefault', 'stopPropagation',
  'stopImmediatePropagation',

  // Browser storage
  'getItem', 'setItem', 'removeItem', 'key', 'length',

  // React
  'createRoot', 'render', 'unmount', 'useState', 'useEffect', 'useCallback',
  'useMemo', 'useRef', 'useContext', 'useReducer',
]);
```

#### Change 2: Modify `isExternalMethod()` function

Replace the current implementation:

```typescript
/**
 * Checks if a method call is external (built-in or well-known library).
 * In strict mode, external methods are skipped (no error if unresolved).
 */
private isExternalMethod(object: string, method: string): boolean {
  // Known global objects (console, Math, etc.)
  const externalObjects = new Set([
    'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
    'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'Set', 'Map',
    'WeakSet', 'WeakMap', 'Symbol', 'Proxy', 'Reflect', 'Intl',
    'process', 'global', 'window', 'document', 'Buffer',
    'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util',
    'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
    'performance', 'fetch', 'XMLHttpRequest', 'WebSocket',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame',
    'Atomics', 'SharedArrayBuffer', 'DataView', 'ArrayBuffer',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
    'Float64Array', 'BigInt64Array', 'BigUint64Array',
  ]);

  // Check if object is a known global
  if (externalObjects.has(object)) {
    return true;
  }

  // Check if method is a built-in prototype method
  if (BUILTIN_PROTOTYPE_METHODS.has(method)) {
    return true;
  }

  // Check if method is a common library method
  if (COMMON_LIBRARY_METHODS.has(method)) {
    return true;
  }

  return false;
}
```

### Complexity Analysis

- **Time Complexity**: O(1) - Set lookups are constant time
- **Space Complexity**: O(1) - Fixed-size sets, no growth with input
- **No impact on iteration patterns** - Same number of method calls processed

### Testing Plan

1. **Unit test for `isExternalMethod()`**
   - Test all built-in prototype methods
   - Test common library patterns
   - Test that user-defined methods still return false

2. **Integration test on Jammers**
   - Before: 850 fatal errors
   - After: Should be ~0 false positives (only real unresolved methods)

### Test Cases

```typescript
// Built-in prototype methods
expect(isExternalMethod('data', 'split')).toBe(true);
expect(isExternalMethod('array', 'map')).toBe(true);
expect(isExternalMethod('date', 'getTime')).toBe(true);
expect(isExternalMethod('promise', 'then')).toBe(true);

// Library methods
expect(isExternalMethod('res', 'json')).toBe(true);
expect(isExternalMethod('router', 'get')).toBe(true);
expect(isExternalMethod('socket', 'emit')).toBe(true);

// Known globals
expect(isExternalMethod('console', 'log')).toBe(true);
expect(isExternalMethod('Math', 'random')).toBe(true);

// User-defined methods (should NOT be external)
expect(isExternalMethod('userService', 'findById')).toBe(false);
expect(isExternalMethod('this', 'myMethod')).toBe(false);
```

### Edge Cases

1. **Method name collision**: `get` could be Map.get or router.get - both are external, so OK
2. **User methods with common names**: User defines `json()` method - would be treated as external
   - Acceptable trade-off: better to have false negative than 850 false positives
3. **`this` calls**: Still go through resolution, may error if method not found
   - This is correct behavior - `this.myMethod` should resolve

### Files Modified

1. `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

### Files Created

1. `test/unit/MethodCallResolver.test.js` - Unit tests for isExternalMethod
