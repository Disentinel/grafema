// =============================================================================
// modules-helpers.js — Export targets for import / re-export pattern demos
// =============================================================================

// @construct PENDING export-inline-const
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<HELPER_CONST>>
// VARIABLE <<HELPER_CONST>> -> ASSIGNED_FROM -> LITERAL <<42>>
// EXPORT <<export-HELPER_CONST>> -> EXPORTS -> VARIABLE <<HELPER_CONST>>
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-HELPER_CONST>>
// @end-annotation
export const HELPER_CONST = 42;

// @construct PENDING export-inline-function
// @annotation
// UNKNOWN <<module>> -> DECLARES -> CLASS <<HelperClass>>
// UNKNOWN <<module>> -> EXPORTS -> CLASS <<HelperClass>>
// CLASS <<HelperClass>> -> CONTAINS -> METHOD <<HelperClass.method>>
// METHOD <<HelperClass.method>> -> RETURNS -> LITERAL <<true>>
// @end-annotation
export function helperFunction() {
  return 'help';
}

// @construct PENDING export-inline-class
export class HelperClass {
  method() {
    return true;
  }
}

// @construct PENDING export-default-function
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<defaultHelper>>
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-default>>
// EXPORT <<export-default>> -> EXPORTS -> FUNCTION <<defaultHelper>>
// FUNCTION <<defaultHelper>> -> RETURNS -> LITERAL <<'default'>>
// @end-annotation
export default function defaultHelper() {
  return 'default';
}

// @construct PENDING export-as-default
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<default-export>>
// EXPORT <<default-export>> -> EXPORTS -> CLASS <<Router>>
// CLASS <<Router>> -> CONTAINS -> METHOD <<Router.navigate>>
// METHOD <<Router.navigate>> -> RETURNS -> LITERAL <<'/'>>
// @end-annotation
// Alternative syntax for default export:
// export { someFunction as default };
// Semantically equivalent to export default, but uses named export syntax

// @construct PENDING export-default-class
// export default class Router { navigate() { return '/'; } }
// Also valid: export default class { anonymous() {} }
// (Only one default export per module — shown above as function)

// @construct PENDING export-default-expression
// export default [1, 2, 3];
// export default 42;
// Any expression can be a default export

// @construct PENDING export-multiple-names-same-binding
const sharedValue = 'shared';
export { sharedValue, sharedValue as sharedAlias, sharedValue as sharedOther };
