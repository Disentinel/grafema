/**
 * Global Symbol Definitions
 *
 * JavaScript/TypeScript globals that should not be reported as undefined.
 * Organized by environment and category.
 */

/**
 * ECMAScript standard globals (available in all JS environments)
 */
export const ECMASCRIPT_GLOBALS: string[] = [
  // Value properties
  'globalThis', 'Infinity', 'NaN', 'undefined',

  // Function properties
  'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent',

  // Fundamental objects
  'Object', 'Function', 'Boolean', 'Symbol',

  // Error objects
  'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'TypeError', 'URIError',

  // Numbers and dates
  'Number', 'BigInt', 'Math', 'Date',

  // Text processing
  'String', 'RegExp',

  // Collections
  'Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet',

  // Structured data
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'JSON',

  // Control abstraction
  'Promise', 'Generator', 'GeneratorFunction', 'AsyncFunction',
  'AsyncGenerator', 'AsyncGeneratorFunction',

  // Reflection
  'Reflect', 'Proxy',

  // Internationalization
  'Intl',
];

/**
 * Node.js-specific globals
 */
export const NODEJS_GLOBALS: string[] = [
  // Core globals
  'console', 'process', 'global', 'Buffer',

  // Timers
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate',

  // Module system
  'require', 'module', 'exports', '__dirname', '__filename',

  // URL/fetch (Node 18+)
  'fetch', 'URL', 'URLSearchParams', 'Request', 'Response', 'Headers',

  // Blob/File (Node 18+)
  'Blob', 'File', 'FormData',

  // Streams
  'ReadableStream', 'WritableStream', 'TransformStream',

  // Crypto
  'crypto', 'Crypto', 'CryptoKey', 'SubtleCrypto',

  // Text encoding
  'TextEncoder', 'TextDecoder',

  // Events
  'Event', 'EventTarget', 'AbortController', 'AbortSignal',

  // Performance
  'performance', 'PerformanceEntry', 'PerformanceObserver',

  // Queuing
  'queueMicrotask',

  // MessageChannel
  'MessageChannel', 'MessagePort', 'BroadcastChannel',

  // Structured clone
  'structuredClone',
];

/**
 * Browser-specific globals (commonly used, may appear in isomorphic code)
 */
export const BROWSER_GLOBALS: string[] = [
  // DOM
  'window', 'document', 'navigator', 'location', 'history',

  // Elements
  'HTMLElement', 'Element', 'Node', 'NodeList', 'DocumentFragment',

  // Events
  'addEventListener', 'removeEventListener', 'CustomEvent',

  // Storage
  'localStorage', 'sessionStorage', 'indexedDB',

  // Workers
  'Worker', 'SharedWorker', 'ServiceWorker',

  // Animation
  'requestAnimationFrame', 'cancelAnimationFrame',

  // Alerts
  'alert', 'confirm', 'prompt',

  // Screen/viewport
  'screen', 'innerWidth', 'innerHeight', 'scrollX', 'scrollY',

  // Image/media
  'Image', 'Audio', 'Video',

  // Observers
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
];

/**
 * Test framework globals (common testing environments)
 */
export const TEST_GLOBALS: string[] = [
  // Node.js test runner
  'describe', 'it', 'test', 'before', 'after', 'beforeEach', 'afterEach',

  // Jest
  'expect', 'jest', 'mock', 'spyOn', 'fn',

  // Mocha/Chai
  'assert', 'should',

  // Vitest
  'vi',
];

/**
 * All default globals combined
 */
export const ALL_GLOBALS: Set<string> = new Set([
  ...ECMASCRIPT_GLOBALS,
  ...NODEJS_GLOBALS,
  ...BROWSER_GLOBALS,
  ...TEST_GLOBALS,
]);
