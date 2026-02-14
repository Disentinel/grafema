# REG-387: Fix FetchAnalyzer unit tests hang (RFDB test server lifecycle)

## Goal

Make `FetchAnalyzer` unit tests exit cleanly without hangs or EPIPE errors.

## Acceptance Criteria

* Running `node --import tsx --test test/unit/plugins/analysis/FetchAnalyzer.test.ts` exits on its own.
* No EPIPE errors from RFDB client/server during test teardown.
* Cleanup is explicit and localized to test setup (no global side effects).

## Context

During REG-384, `FetchAnalyzer.test.ts` passed assertions but the Node test runner hung due to open handles. A follow-up attempt with shared cleanup caused EPIPE (RFDB connection closed while async activity still ongoing). This appears to be a test server lifecycle / cleanup ordering issue.
