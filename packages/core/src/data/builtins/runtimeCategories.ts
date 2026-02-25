/**
 * Runtime Categories — authoritative categorization of JS/Web APIs (REG-583)
 *
 * Maps global object names and standalone function names to their
 * runtime-specific node types and IDs.
 *
 * Used by:
 * - MethodCallResolver: obj.method() lookup
 * - ExternalCallResolver: bare fn() lookup
 * - CallResolverValidator: builtin recognition
 */

/**
 * ECMASCRIPT_BUILTIN objects — defined by the ECMAScript specification.
 * Available in all JS environments. method calls → ECMASCRIPT_BUILTIN:{name}
 */
export const ECMASCRIPT_BUILTIN_OBJECTS: ReadonlySet<string> = new Set([
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'Error', 'Promise', 'Set', 'Map', 'WeakSet', 'WeakMap',
  'Symbol', 'Proxy', 'Reflect', 'Intl', 'Atomics', 'DataView', 'ArrayBuffer',
  'SharedArrayBuffer',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
]);

/**
 * WEB_API objects — WHATWG/W3C spec, available in browsers AND Node.js 18+.
 * method calls → WEB_API:{name}
 */
export const WEB_API_OBJECTS: ReadonlySet<string> = new Set([
  'console', 'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'performance', 'AbortController', 'AbortSignal', 'Event', 'EventTarget',
  'FormData', 'Headers', 'Request', 'Response',
  'ReadableStream', 'WritableStream', 'TransformStream', 'Blob',
]);

/**
 * WEB_API global functions — HTML spec or WHATWG, available everywhere.
 * bare fn() calls → WEB_API:{name}
 */
export const WEB_API_FUNCTIONS: ReadonlySet<string> = new Set([
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'structuredClone',
]);

/**
 * BROWSER_API objects — browser-only, not available in Node.js.
 * method calls → BROWSER_API:{name}
 */
export const BROWSER_API_OBJECTS: ReadonlySet<string> = new Set([
  'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
  'location', 'history', 'screen',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'IndexedDB',
  'WebSocket',
  'XMLHttpRequest',
  'requestAnimationFrame', 'cancelAnimationFrame',
]);

/**
 * BROWSER_API global functions — browser-only, not available in Node.js.
 * bare fn() calls → BROWSER_API:{name}
 */
export const BROWSER_API_FUNCTIONS: ReadonlySet<string> = new Set([
  'requestAnimationFrame', 'cancelAnimationFrame',
  'alert', 'confirm', 'prompt',
]);

/**
 * NODEJS_STDLIB objects — Node.js runtime only, not available in browsers.
 * method calls → NODEJS_STDLIB:{name}
 *
 * Includes both Node.js globals (process, Buffer, global) and Node.js built-in
 * module namespaces (fs, path, http, etc.) for cases where NodejsBuiltinsResolver
 * does not create a precise EXTERNAL_FUNCTION edge (e.g., dynamic require patterns,
 * CommonJS require without explicit binding analysis).
 */
export const NODEJS_STDLIB_OBJECTS: ReadonlySet<string> = new Set([
  // Node.js globals
  'process', 'Buffer', 'global',
  // Node.js built-in module namespaces
  'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util',
  'stream', 'events', 'child_process', 'cluster', 'net', 'dns',
  'readline', 'repl', 'vm', 'worker_threads', 'perf_hooks', 'assert',
  'zlib', 'tls', 'dgram', 'module',
]);

/**
 * NODEJS_STDLIB global functions — Node.js only.
 * bare fn() calls → NODEJS_STDLIB:{name}
 */
export const NODEJS_STDLIB_FUNCTIONS: ReadonlySet<string> = new Set([
  'setImmediate', 'clearImmediate',
]);

/**
 * ECMASCRIPT_BUILTIN global functions — ECMAScript spec standalone functions.
 * bare fn() calls → ECMASCRIPT_BUILTIN:{name}
 */
export const ECMASCRIPT_BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
]);

/**
 * Lookup: object name -> ECMASCRIPT_BUILTIN node ID
 * Used by MethodCallResolver for O(1) target resolution.
 */
export const ECMASCRIPT_BUILTIN_OBJECT_IDS: ReadonlyMap<string, string> =
  new Map([...ECMASCRIPT_BUILTIN_OBJECTS].map(name => [name, `ECMASCRIPT_BUILTIN:${name}`]));

/**
 * Lookup: object name -> WEB_API node ID
 */
export const WEB_API_OBJECT_IDS: ReadonlyMap<string, string> =
  new Map([...WEB_API_OBJECTS].map(name => [name, `WEB_API:${name}`]));

/**
 * Lookup: function name -> WEB_API node ID
 */
export const WEB_API_FUNCTION_IDS: ReadonlyMap<string, string> =
  new Map([...WEB_API_FUNCTIONS].map(name => [name, `WEB_API:${name}`]));

/**
 * Lookup: object name -> BROWSER_API node ID
 */
export const BROWSER_API_OBJECT_IDS: ReadonlyMap<string, string> =
  new Map([...BROWSER_API_OBJECTS].map(name => [name, `BROWSER_API:${name}`]));

/**
 * Lookup: function name -> BROWSER_API node ID
 */
export const BROWSER_API_FUNCTION_IDS: ReadonlyMap<string, string> =
  new Map([...BROWSER_API_FUNCTIONS].map(name => [name, `BROWSER_API:${name}`]));

/**
 * Lookup: object name -> NODEJS_STDLIB node ID
 */
export const NODEJS_STDLIB_OBJECT_IDS: ReadonlyMap<string, string> =
  new Map([...NODEJS_STDLIB_OBJECTS].map(name => [name, `NODEJS_STDLIB:${name}`]));

/**
 * Lookup: function name -> NODEJS_STDLIB node ID
 */
export const NODEJS_STDLIB_FUNCTION_IDS: ReadonlyMap<string, string> =
  new Map([...NODEJS_STDLIB_FUNCTIONS].map(name => [name, `NODEJS_STDLIB:${name}`]));

/**
 * Lookup: function name -> ECMASCRIPT_BUILTIN node ID
 */
export const ECMASCRIPT_BUILTIN_FUNCTION_IDS: ReadonlyMap<string, string> =
  new Map([...ECMASCRIPT_BUILTIN_FUNCTIONS].map(name => [name, `ECMASCRIPT_BUILTIN:${name}`]));

/**
 * Combined set of ALL objects that are known builtins/stdlib/platform APIs.
 * Used by isKnownBuiltinObject() to distinguish known targets from unknown variables.
 */
export const ALL_KNOWN_OBJECTS: ReadonlySet<string> = new Set([
  ...ECMASCRIPT_BUILTIN_OBJECTS,
  ...WEB_API_OBJECTS,
  ...BROWSER_API_OBJECTS,
  ...NODEJS_STDLIB_OBJECTS,
]);

/**
 * Combined set of ALL global functions that are known builtins/stdlib/platform APIs.
 * Used by ExternalCallResolver and CallResolverValidator.
 * Does NOT include 'require' — it is modeled via IMPORT nodes.
 */
export const ALL_KNOWN_FUNCTIONS: ReadonlySet<string> = new Set([
  ...ECMASCRIPT_BUILTIN_FUNCTIONS,
  ...WEB_API_FUNCTIONS,
  ...NODEJS_STDLIB_FUNCTIONS,
  ...BROWSER_API_FUNCTIONS,
]);

/**
 * Resolve an object name to its builtin node ID.
 *
 * Returns null if the object is not a known builtin — that object
 * is then a candidate for UNKNOWN_CALL_TARGET.
 *
 * @param objectName - The object identifier from the call (e.g., 'Math', 'res', 'console')
 * @returns Target node ID string, or null if not a known builtin
 */
export function resolveBuiltinObjectId(objectName: string): string | null {
  return (
    ECMASCRIPT_BUILTIN_OBJECT_IDS.get(objectName) ??
    WEB_API_OBJECT_IDS.get(objectName) ??
    BROWSER_API_OBJECT_IDS.get(objectName) ??
    NODEJS_STDLIB_OBJECT_IDS.get(objectName) ??
    null
  );
}

/**
 * Resolve a bare function name to its builtin node ID.
 *
 * Returns null if not a known global function.
 *
 * @param fnName - Function name (e.g., 'parseInt', 'setTimeout', 'require')
 * @returns Target node ID string, or null
 */
export function resolveBuiltinFunctionId(fnName: string): string | null {
  return (
    ECMASCRIPT_BUILTIN_FUNCTION_IDS.get(fnName) ??
    WEB_API_FUNCTION_IDS.get(fnName) ??
    NODEJS_STDLIB_FUNCTION_IDS.get(fnName) ??
    BROWSER_API_FUNCTION_IDS.get(fnName) ??
    null
  );
}

/**
 * Extract node type string from a builtin node ID.
 * Used by NodeFactory to select the correct creator.
 *
 * @param nodeId - e.g., 'ECMASCRIPT_BUILTIN:Math', 'WEB_API:console'
 * @returns type string before ':', or null if not a builtin ID
 */
export function getBuiltinNodeType(nodeId: string): string | null {
  const colonIdx = nodeId.indexOf(':');
  if (colonIdx === -1) return null;
  const type = nodeId.slice(0, colonIdx);
  if (
    type === 'ECMASCRIPT_BUILTIN' ||
    type === 'WEB_API' ||
    type === 'BROWSER_API' ||
    type === 'NODEJS_STDLIB'
  ) {
    return type;
  }
  return null;
}
