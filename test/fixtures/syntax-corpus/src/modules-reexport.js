// =============================================================================
// modules-reexport.js — Re-export Patterns
// =============================================================================

// @construct PENDING reexport-named
// @annotation
// MODULE <<module>> -> CONTAINS -> EXPORT <<export-helperFunction>>
// EXPORT <<export-helperFunction>> -> EXPORTS -> VARIABLE <<helperFunction>>
// EXPORT <<export-helperFunction>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-helpers.js>>
// MODULE <<module>> -> DEPENDS_ON -> EXTERNAL_MODULE <<./modules-helpers.js>>
// @end-annotation
export { helperFunction } from './modules-helpers.js';

// @construct PENDING reexport-aliased
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-star>>
// EXPORT <<export-star>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./declarations.js>>
// UNKNOWN <<module>> -> DEPENDS_ON -> EXTERNAL_MODULE <<./declarations.js>>
// @end-annotation
export { HELPER_CONST as RENAMED_CONST } from './modules-helpers.js';

// @construct PENDING reexport-star
// @annotation
// EXPORT <<export-default-as-named>> -> EXPORTS -> VARIABLE <<defaultFn>>
// EXPORT <<export-default-as-named>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-helpers.js>>
// VARIABLE <<defaultFn>> -> ALIASES -> EXTERNAL <<./modules-helpers.js:default>>
// EXTERNAL_MODULE <<./modules-helpers.js>> -> EXPORTS -> EXTERNAL <<./modules-helpers.js:default>>
// @end-annotation
export * from './declarations.js';

// @construct PENDING reexport-default-as-named
// @annotation
// EXPORT <<export-namespace>> -> EXPORTS -> IMPORT <<import-all>>
// IMPORT <<import-all>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-helpers.js>>
// @end-annotation
export { default as defaultFn } from './modules-helpers.js';

// @construct PENDING reexport-namespace
// @annotation
// MODULE <<fileA>> -> DECLARES -> VARIABLE <<count>>
// VARIABLE <<count>> -> ASSIGNED_FROM -> LITERAL <<0>>
// MODULE <<fileA>> -> DECLARES -> FUNCTION <<inc>>
// FUNCTION <<inc>> -> CONTAINS -> EXPRESSION <<count++>>
// EXPRESSION <<count++>> -> MODIFIES -> VARIABLE <<count>>
// MODULE <<fileA>> -> EXPORTS -> VARIABLE <<count>>
// MODULE <<fileA>> -> EXPORTS -> FUNCTION <<inc>>
// MODULE <<fileB>> -> CONTAINS -> IMPORT <<import-a>>
// IMPORT <<import-a>> -> IMPORTS -> VARIABLE <<count:imported>>
// IMPORT <<import-a>> -> IMPORTS -> VARIABLE <<inc:imported>>
// MODULE <<fileB>> -> IMPORTS_FROM -> MODULE <<fileA>>
// VARIABLE <<count:imported>> -> ALIASES -> VARIABLE <<count>>
// VARIABLE <<inc:imported>> -> ALIASES -> FUNCTION <<inc>>
// CALL <<inc()>> -> CALLS -> VARIABLE <<inc:imported>>
// CALL <<console.log(count)>> -> READS_FROM -> VARIABLE <<count:imported>>
// @end-annotation
export * as helpers from './modules-helpers.js';

// --- Multi-file module patterns (construct references only) ---

// @construct PENDING circular-import-live-binding
// @annotation
// IMPORT <<import-utils>> -> IMPORTS -> VARIABLE <<utils>>
// IMPORT <<import-utils>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./modules-helpers.js>>
// CALL <<utils.helperFunction()>> -> CALLS -> PROPERTY_ACCESS <<utils.helperFunction>>
// PROPERTY_ACCESS <<utils.helperFunction>> -> READS_FROM -> VARIABLE <<utils>>
// VARIABLE <<helperFunction>> -> ASSIGNED_FROM -> VARIABLE <<utils>>
// VARIABLE <<fn>> -> ASSIGNED_FROM -> PROPERTY_ACCESS <<utils['helperFunction']>>
// PROPERTY_ACCESS <<utils['helperFunction']>> -> READS_FROM -> VARIABLE <<utils>>
// @end-annotation
// File A: export let count = 0; export function inc() { count++; }
// File B: import { count, inc } from './a.js'; inc(); console.log(count); // 1 — live binding!
// Graph impact: imported let is NOT a copy — mutations in source module visible to importers

// @construct PENDING star-import-namespace
// import * as utils from './modules-helpers.js';
// utils.helperFunction();          // method on namespace object
// const { helperFunction } = utils; // destructured from namespace
// const fn = utils['helperFunction']; // bracket access on namespace

// @construct PENDING star-reexport-collision
// a.js: export const x = 1;
// b.js: export const x = 2;
// barrel.js: export * from './a'; export * from './b'; // x is ambiguous!
// Explicit re-export wins: export * from './a'; export { x } from './b';

// @construct PENDING import-meta-url
// const __filename = new URL(import.meta.url).pathname;
// const __dirname = new URL('.', import.meta.url).pathname;
// const workerUrl = new URL('./worker.js', import.meta.url); // implicit file dependency
