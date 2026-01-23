# User Request: REG-147

## Linear Issue

**REG-147: Update JSModuleIndexer to use GrafemaError**

## Description

JSModuleIndexer silently ignores parse failures. When a file can't be parsed (syntax error, unsupported language), it should log a LanguageError so users know why files were skipped.

## Implementation

1. In processFile() catch block, create LanguageError with ERR_PARSE_FAILURE
2. Add error to PluginResult.errors[]
3. Include file path and suggestion in error context

## Acceptance Criteria

- [ ] Parse failures logged as LanguageError
- [ ] Errors appear in DiagnosticCollector
- [ ] Summary shows "X files skipped due to parse errors"

## Dependencies

REG-78 (infrastructure complete)

## Labels

Bug
