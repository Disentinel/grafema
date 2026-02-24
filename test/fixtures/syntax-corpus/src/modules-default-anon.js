// =============================================================================
// modules-default-anon.js — Anonymous Default Exports
// =============================================================================

// @construct PENDING export-default-anonymous-function
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<default-export>>
// EXPORT <<default-export>> -> EXPORTS -> FUNCTION <<anonymous-default-function>>
// FUNCTION <<anonymous-default-function>> -> RETURNS -> LITERAL <<'anonymous but hoisted'>>
// @end-annotation
export default function() {
  return 'anonymous but hoisted';
}

// Only one `export default` per module — other forms as comments:

// @construct PENDING export-default-anonymous-class
// @annotation
// EXPORT <<default-export>> -> EXPORTS -> CLASS <<anonymous-class>>
// CLASS <<anonymous-class>> -> CONTAINS -> METHOD <<anonymous-class.run>>
// METHOD <<anonymous-class.run>> -> RETURNS -> LITERAL <<'anonymous class'>>
// @end-annotation
// export default class { run() { return 'anonymous class'; } }

// @construct PENDING export-default-expression
// export default [1, 2, 3];
// export default { key: 'value' };
// export default 42;
