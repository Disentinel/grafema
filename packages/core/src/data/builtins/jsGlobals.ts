/**
 * JavaScript Global Functions (REG-227)
 *
 * These are functions intrinsic to the JS runtime that don't need CALLS edges.
 * They're available in all JS environments (browser, Node.js, etc.) and aren't
 * "callable definitions" in the code sense.
 *
 * What is NOT included:
 * - Constructors (Array, Object, Error) - handled as constructor calls
 * - Objects with methods (Math, JSON) - method calls go through MethodCallResolver
 * - Environment globals (window, document) - not functions, they're objects
 *
 * Used by:
 * - ExternalCallResolver: skips these when resolving external calls
 * - CallResolverValidator: recognizes these as resolved (no violation)
 */
export const JS_GLOBAL_FUNCTIONS = new Set([
  // Global functions (truly called as standalone functions)
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',

  // Timers (global functions in browser & Node.js)
  'setTimeout', 'setInterval', 'setImmediate',
  'clearTimeout', 'clearInterval', 'clearImmediate',

  // CommonJS (special case - global in CJS environments)
  'require'
]);
