# REG-78: Error handling & diagnostics

**Linear Issue:** https://linear.app/reginaflow/issue/REG-78/error-handling-and-diagnostics
**Priority:** Urgent
**Labels:** Improvement

## Description

Remove "silent failures" and make diagnostics understandable.

## Acceptance Criteria

* Clear error messages for:
  * missing git access
  * unsupported language
  * repo skipped
* Debug mode for local diagnostics

## Implementation Requirements

* Structured error messages
* Verbose logging option
* Error recovery strategies
