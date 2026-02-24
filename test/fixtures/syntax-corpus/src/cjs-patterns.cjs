// =============================================================================
// cjs-patterns.cjs — CommonJS Module Patterns (non-strict / sloppy mode)
// =============================================================================

// @construct PENDING require-simple
// @annotation
// VARIABLE <<fs>> -> ASSIGNED_FROM -> CALL <<require('fs')>>
// CALL <<require('fs')>> -> PASSES_ARGUMENT -> LITERAL <<'fs'>>
// CALL <<require('fs')>> -> IMPORTS -> EXTERNAL_MODULE <<fs-module>>
// @end-annotation
const fs = require('fs');

// @construct PENDING require-destructured
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<path>>
// VARIABLE <<path>> -> ASSIGNED_FROM -> CALL <<require('path')>>
// CALL <<require('path')>> -> CALLS -> UNKNOWN <<require>>
// CALL <<require('path')>> -> PASSES_ARGUMENT -> LITERAL <<'path'>>
// CALL <<require('path')>> -> IMPORTS -> EXTERNAL_MODULE <<path-module>>
// UNKNOWN <<module>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<path-module>>
// @end-annotation
const { readFile, writeFile } = require('fs/promises');

// @construct PENDING require-path
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<optionalDep>>
// UNKNOWN <<module>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<require('optional-package')>>
// CALL <<require('optional-package')>> -> PASSES_ARGUMENT -> LITERAL <<'optional-package'>>
// VARIABLE <<optionalDep>> -> ASSIGNED_FROM -> CALL <<require('optional-package')>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<e>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> LITERAL <<null>>
// VARIABLE <<optionalDep>> -> ASSIGNED_FROM -> LITERAL <<null>>
// @end-annotation
const path = require('path');

// @construct PENDING require-conditional
let optionalDep;
try {
  optionalDep = require('optional-package');
} catch (e) {
  optionalDep = null;
}

// @construct PENDING cjs-function-decl
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<cjsFunction>>
// FUNCTION <<cjsFunction>> -> RETURNS -> LITERAL <<'cjs'>>
// @end-annotation
function cjsFunction() {
  return 'cjs';
}

// @construct PENDING cjs-class-decl
class CjsClass {
  method() {
    return true;
  }
}

// @construct PENDING cjs-const-decl
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<CJS_CONSTANT>>
// VARIABLE <<CJS_CONSTANT>> -> ASSIGNED_FROM -> LITERAL <<42>>
// @end-annotation
const CJS_CONSTANT = 42;

// @construct PENDING cjs-exports-named
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<exports.CjsClass>>
// EXPORT <<exports.CjsClass>> -> WRITES_TO -> PROPERTY_ACCESS <<exports.CjsClass:access>>
// PROPERTY_ACCESS <<exports.CjsClass:access>> -> ASSIGNED_FROM -> UNKNOWN <<CjsClass>>
// EXPORT <<exports.CjsClass>> -> EXPORTS -> UNKNOWN <<CjsClass>>
// @end-annotation
exports.cjsFunction = cjsFunction;

// @construct PENDING cjs-exports-named
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> PROPERTY_ACCESS <<exports.CJS_CONSTANT>>
// PROPERTY_ACCESS <<exports.CJS_CONSTANT>> -> ASSIGNED_FROM -> VARIABLE <<CJS_CONSTANT>>
// UNKNOWN <<module>> -> EXPORTS -> VARIABLE <<CJS_CONSTANT>>
// @end-annotation
exports.CjsClass = CjsClass;

// @construct PENDING cjs-exports-named
// @annotation
// UNKNOWN <<MODULE>> -> DECLARES -> FUNCTION <<withStatement>>
// FUNCTION <<withStatement>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<withStatement>> -> HAS_SCOPE -> SCOPE <<with-scope>>
// SCOPE <<with-scope>> -> EXTENDS_SCOPE_WITH -> PARAMETER <<obj>>
// SCOPE <<with-scope>> -> CONTAINS -> CALL <<toString()>>
// FUNCTION <<withStatement>> -> RETURNS -> CALL <<toString()>>
// CALL <<toString()>> -> RESOLVES_TO -> PARAMETER <<obj>>
// PROPERTY_ACCESS <<exports.withStatement>> -> ASSIGNED_FROM -> FUNCTION <<withStatement>>
// UNKNOWN <<MODULE>> -> EXPORTS -> PROPERTY_ACCESS <<exports.withStatement>>
// @end-annotation
exports.CJS_CONSTANT = CJS_CONSTANT;

// @construct PENDING with-statement
function withStatement(obj) {
  with (obj) {
    return toString();
  }
}

exports.withStatement = withStatement;

// @construct PENDING cjs-conditional-exports
// @annotation
// BRANCH <<conditional-exports>> -> HAS_CONDITION -> EXPRESSION <<condition>>
// EXPRESSION <<condition>> -> READS_FROM -> EXPRESSION <<typeof-check>>
// EXPRESSION <<condition>> -> READS_FROM -> EXPRESSION <<env-check>>
// EXPRESSION <<typeof-check>> -> READS_FROM -> EXTERNAL <<process>>
// EXPRESSION <<env-check>> -> READS_FROM -> PROPERTY_ACCESS <<process.env.NODE_ENV>>
// PROPERTY_ACCESS <<process.env.NODE_ENV>> -> READS_FROM -> EXTERNAL <<process>>
// BRANCH <<conditional-exports>> -> HAS_CONSEQUENT -> PROPERTY_ACCESS <<exports._testHelper>>
// BRANCH <<conditional-exports>> -> HAS_CONSEQUENT -> PROPERTY_ACCESS <<exports._internal>>
// PROPERTY_ACCESS <<exports._testHelper>> -> ASSIGNED_FROM -> FUNCTION <<testHelper:fn>>
// FUNCTION <<testHelper:fn>> -> RETURNS -> LITERAL <<'test-only'>>
// PROPERTY_ACCESS <<exports._internal>> -> ASSIGNED_FROM -> VARIABLE <<cjsFunction>>
// @end-annotation
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  exports._testHelper = function () { return 'test-only'; };
  exports._internal = cjsFunction;
}

// @construct PENDING cjs-dynamic-require
// @annotation
// FUNCTION <<loadImplementation>> -> CONTAINS -> PARAMETER <<useNative>>
// FUNCTION <<loadImplementation>> -> CONTAINS -> VARIABLE <<impl>>
// VARIABLE <<impl>> -> ASSIGNED_FROM -> EXPRESSION <<ternary>>
// EXPRESSION <<ternary>> -> HAS_CONDITION -> PARAMETER <<useNative>>
// EXPRESSION <<ternary>> -> HAS_CONSEQUENT -> CALL <<require('path')>>
// EXPRESSION <<ternary>> -> HAS_ALTERNATE -> CALL <<require('fs')>>
// CALL <<require('path')>> -> CALLS -> EXTERNAL <<require>>
// CALL <<require('path')>> -> PASSES_ARGUMENT -> LITERAL <<'path'>>
// CALL <<require('fs')>> -> CALLS -> EXTERNAL <<require>>
// CALL <<require('fs')>> -> PASSES_ARGUMENT -> LITERAL <<'fs'>>
// FUNCTION <<loadImplementation>> -> RETURNS -> VARIABLE <<impl>>
// @end-annotation
function loadImplementation(useNative) {
  const impl = useNative ? require('path') : require('fs');
  return impl;
}

// @construct PENDING block-function-decl-annex-b
// @annotation
// FUNCTION <<annexBDemo>> -> CONTAINS -> CALL <<console.log(typeof leaked)>>
// CALL <<console.log(typeof leaked)>> -> PASSES_ARGUMENT -> EXPRESSION <<typeof leaked>>
// EXPRESSION <<typeof leaked>> -> READS_FROM -> FUNCTION <<leaked>>
// FUNCTION <<annexBDemo>> -> CONTAINS -> BRANCH <<if-true>>
// BRANCH <<if-true>> -> HAS_CONDITION -> LITERAL <<true>>
// BRANCH <<if-true>> -> CONTAINS -> FUNCTION <<leaked>>
// FUNCTION <<leaked>> -> RETURNS -> LITERAL <<'I escaped!'>>
// FUNCTION <<annexBDemo>> -> CONTAINS -> CALL <<leaked()>>
// CALL <<leaked()>> -> CALLS -> FUNCTION <<leaked>>
// FUNCTION <<annexBDemo>> -> RETURNS -> CALL <<leaked()>>
// @end-annotation
// Sloppy mode (CJS) — Annex B behavior: function leaks out of block
function annexBDemo() {
  console.log(typeof leaked); // "undefined" — var-hoisted but not initialized

  if (true) {
    function leaked() { return 'I escaped!'; }
  }

  return leaked(); // works in sloppy mode — Annex B hoisting
}

// @construct PENDING with-nested
// @annotation
// FUNCTION <<withNested>> -> CONTAINS -> PARAMETER <<defaults>>
// FUNCTION <<withNested>> -> CONTAINS -> PARAMETER <<overrides>>
// SCOPE <<with-defaults-scope>> -> EXTENDS_SCOPE_WITH -> PARAMETER <<defaults>>
// SCOPE <<with-overrides-scope>> -> EXTENDS_SCOPE_WITH -> PARAMETER <<overrides>>
// SCOPE <<with-overrides-scope>> -> CONTAINS -> SCOPE <<with-defaults-scope>>
// FUNCTION <<withNested>> -> RETURNS -> VARIABLE <<color>>
// VARIABLE <<color>> -> RESOLVES_TO -> SCOPE <<with-overrides-scope>>
// @end-annotation
function withNested(defaults, overrides) {
  with (defaults) {
    with (overrides) {
      return color; // overrides.color ?? defaults.color ?? outer scope
    }
  }
}

// @construct PENDING with-property-fallback
// @annotation
// VARIABLE <<fallbackColor>> -> ASSIGNED_FROM -> LITERAL <<'red'>>
// FUNCTION <<withPropertyFallback>> -> CONTAINS -> PARAMETER <<config>>
// FUNCTION <<withPropertyFallback>> -> HAS_SCOPE -> SCOPE <<with-scope>>
// SCOPE <<with-scope>> -> EXTENDS_SCOPE_WITH -> PARAMETER <<config>>
// SCOPE <<with-scope>> -> CONTAINS -> EXPRESSION <<fallbackColor-ref>>
// FUNCTION <<withPropertyFallback>> -> RETURNS -> EXPRESSION <<fallbackColor-ref>>
// EXPRESSION <<fallbackColor-ref>> -> READS_FROM -> VARIABLE <<fallbackColor>>
// EXPRESSION <<fallbackColor-ref>> -> READS_FROM -> PARAMETER <<config>>
// EXPORT <<exports.loadImplementation>> -> EXPORTS -> UNKNOWN <<loadImplementation>>
// EXPORT <<exports.annexBDemo>> -> EXPORTS -> UNKNOWN <<annexBDemo>>
// EXPORT <<exports.withNested>> -> EXPORTS -> UNKNOWN <<withNested>>
// EXPORT <<exports.withPropertyFallback>> -> EXPORTS -> FUNCTION <<withPropertyFallback>>
// @end-annotation
const fallbackColor = 'red';
function withPropertyFallback(config) {
  with (config) {
    return fallbackColor; // config.fallbackColor ?? outer fallbackColor — ambiguous
  }
}

exports.loadImplementation = loadImplementation;
exports.annexBDemo = annexBDemo;
exports.withNested = withNested;
exports.withPropertyFallback = withPropertyFallback;
