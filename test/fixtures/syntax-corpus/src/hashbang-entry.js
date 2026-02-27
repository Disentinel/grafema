#!/usr/bin/env node
// =============================================================================
// hashbang-entry.js — Hashbang (shebang) comment on line 1
// =============================================================================
// The #! on line 1 must be handled by the parser.
// If skipped incorrectly, all line numbers shift by one.

// @construct PENDING hashbang-comment
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXTERNAL <<#!/usr/bin/env node>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<hashbangMain>>
// FUNCTION <<hashbangMain>> -> CONTAINS -> PARAMETER <<args>>
// FUNCTION <<hashbangMain>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> HAS_PROPERTY -> LITERAL <<true>>
// LITERAL <<{...}>> -> READS_FROM -> PARAMETER <<args>>
// @end-annotation
// The #!/usr/bin/env node line above is a HashbangComment node in the AST.
// It is the ONLY position where # is legal outside a string/comment/private-field.

function hashbangMain(args) {
  return { ran: true, args };
}

// @construct PENDING export-named-list
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> EXPORT <<export-hashbangMain>>
// EXPORT <<export-hashbangMain>> -> EXPORTS -> VARIABLE <<hashbangMain>>
// @end-annotation
export { hashbangMain };
