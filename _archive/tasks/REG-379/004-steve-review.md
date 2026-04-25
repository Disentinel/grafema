# Steve Jobs Review #1: REJECT

**Reason:** File-based approach is a hack around broken DECORATOR infrastructure. Should query DECORATOR nodes instead. O(d) not O(m).

## Critical Discovery (post-review)

Babel 7.28 with `plugins: ['jsx', 'typescript']` does NOT parse decorators. Error: "requires enabling 'decorators' or 'decorators-legacy' plugin."

This means:
- JSASTAnalyzer currently **silently fails** on ALL files with decorators
- DECORATOR nodes are **never created** in the graph
- The infrastructure code is correct but unreachable due to parser config

**Root cause:** Missing `'decorators-legacy'` in JSASTAnalyzer parser plugins.

**Fix:** Add `'decorators-legacy'` to `plugins: ['jsx', 'typescript']` → `plugins: ['jsx', 'typescript', 'decorators-legacy']`

Verified: With this fix, Babel correctly parses all NestJS decorator patterns (string, array, object args).
