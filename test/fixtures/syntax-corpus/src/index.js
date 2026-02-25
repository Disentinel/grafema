// =============================================================================
// index.js — Entry Point. Demonstrates all import patterns.
// =============================================================================

// @construct PENDING import-default
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> IMPORT <<import-modules-helpers>>
// IMPORT <<import-modules-helpers>> -> IMPORTS -> VARIABLE <<defaultExport>>
// IMPORT <<import-modules-helpers>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-helpers.js>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<defaultExport>>
// @end-annotation
import defaultExport from './modules-helpers.js';

// @construct PENDING import-named
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> IMPORT <<import-modules-helpers>>
// IMPORT <<import-modules-helpers>> -> IMPORTS -> VARIABLE <<Helper>>
// UNKNOWN <<module>> -> IMPORTS_FROM -> UNKNOWN <<./modules-helpers.js>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<Helper>>
// @end-annotation
import { helperFunction, HELPER_CONST } from './modules-helpers.js';

// @construct PENDING import-aliased
// @annotation
// IMPORT <<import-modules-helpers>> -> IMPORTS -> VARIABLE <<mainFn>>
// IMPORT <<import-modules-helpers>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-helpers.js>>
// @end-annotation
import { HelperClass as Helper } from './modules-helpers.js';

// @construct PENDING import-default-as-named
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> IMPORT <<import-allHelpers>>
// IMPORT <<import-allHelpers>> -> IMPORTS -> VARIABLE <<allHelpers>>
// UNKNOWN <<module>> -> IMPORTS_FROM -> UNKNOWN <<./modules-helpers.js>>
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<allHelpers>>
// @end-annotation
import { default as mainFn } from './modules-helpers.js';

// @construct PENDING import-namespace
// @annotation
// @end-annotation
import * as allHelpers from './modules-helpers.js';

// @construct PENDING import-side-effect
import './declarations.js';
import './expressions.js';
import './statements.js';
import './patterns.js';
import './classes.js';
import './async-generators.js';
import './closures.js';
import './aliasing.js';
import './prototypes.js';
import './callbacks.js';
import './error-handling.js';
import './iterators.js';
import './property-access.js';
import './builtins.js';
import './coercion-hoisting.js';
import './modern-es.js';
import './runtime-apis.js';
import './jsdoc-types.js';
import './modules-default-anon.js';
import './hashbang-entry.js';
import './ts-specific.ts';

// @construct PENDING reexport-star
// @annotation
// EXPORT <<export-star>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-reexport.js>>
// @end-annotation
export * from './modules-reexport.js';

// @construct PENDING import-dynamic
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<currentUrl>>
// VARIABLE <<currentUrl>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<import.meta.url>>
// PROPERTY_ACCESS <<import.meta.url>> -> READS_FROM -> META_PROPERTY <<import.meta>>
// @end-annotation
const dynamicModule = await import('./patterns.js');

// @construct PENDING import-meta
// @annotation
// FUNCTION <<useNamespaceAsValue>> -> CONTAINS -> PARAMETER <<ns>>
// VARIABLE <<fn>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<ns[arguments[1]]>>
// PROPERTY_ACCESS <<ns[arguments[1]]>> -> READS_FROM -> PARAMETER <<ns>>
// EXPRESSION <<typeof fn === 'function'>> -> READS_FROM -> EXPRESSION <<typeof fn>>
// EXPRESSION <<typeof fn === 'function'>> -> READS_FROM -> LITERAL <<'function'>>
// EXPRESSION <<typeof fn>> -> READS_FROM -> VARIABLE <<fn>>
// FUNCTION <<useNamespaceAsValue>> -> HAS_CONDITION -> EXPRESSION <<typeof fn === 'function'>>
// FUNCTION <<useNamespaceAsValue>> -> HAS_CONSEQUENT -> CALL <<fn()>>
// CALL <<fn()>> -> CALLS -> VARIABLE <<fn>>
// FUNCTION <<useNamespaceAsValue>> -> HAS_ALTERNATE -> LITERAL <<undefined>>
// VARIABLE <<helperResult>> -> ASSIGNED_FROM -> CALL <<useNamespaceAsValue(allHelpers, 'helperFunction')>>
// CALL <<useNamespaceAsValue(allHelpers, 'helperFunction')>> -> CALLS -> FUNCTION <<useNamespaceAsValue>>
// CALL <<useNamespaceAsValue(allHelpers, 'helperFunction')>> -> PASSES_ARGUMENT -> LITERAL <<'helperFunction'>>
// @end-annotation
const currentUrl = import.meta.url;

// --- Module namespace object as first-class value ---

// @construct PENDING module-namespace-as-value
function useNamespaceAsValue(ns) {
  const fn = ns[arguments[1]]; // dynamic dispatch through namespace
  return typeof fn === 'function' ? fn() : undefined;
}
const helperResult = useNamespaceAsValue(allHelpers, 'helperFunction');

// @construct PENDING module-namespace-destructured
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<destructuredHelper>>
// VARIABLE <<destructuredHelper>> -> ASSIGNED_FROM -> EXPRESSION <<{helperFunction: destructuredHelper}>>
// EXPRESSION <<{helperFunction: destructuredHelper}>> -> READS_FROM -> UNKNOWN <<allHelpers>>
// EXPRESSION <<{helperFunction: destructuredHelper}>> -> READS_FROM -> PROPERTY_ACCESS <<allHelpers.helperFunction>>
// PROPERTY_ACCESS <<allHelpers.helperFunction>> -> READS_FROM -> UNKNOWN <<allHelpers>>
// @end-annotation
const { helperFunction: destructuredHelper } = allHelpers;

// @construct PENDING export-named-list
export { defaultExport, helperFunction, HELPER_CONST, Helper, allHelpers, mainFn, helperResult, destructuredHelper };
