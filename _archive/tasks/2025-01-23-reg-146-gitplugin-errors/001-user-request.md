# User Request: REG-146 - Update GitPlugin to use GrafemaError

## Linear Issue

**ID:** REG-146
**Title:** Update GitPlugin to use GrafemaError
**Labels:** Bug

## Description

GitPlugin has 6+ silent catch blocks that swallow errors. These should be replaced with FileAccessError/PluginError to provide visibility into git-related failures.

## Silent Failures to Fix

1. `catch { return [] }` in getGitHistory()
2. `catch { return null }` in getLastCommitForFile()
3. Various try-catch blocks that return empty values

## Implementation

1. Replace silent returns with FileAccessError throws or logging
2. Use appropriate error codes: ERR_GIT_NOT_FOUND, ERR_GIT_ACCESS_DENIED
3. Add suggestions like "Run `git init`" or "Check .git permissions"

## Acceptance Criteria

- [ ] No silent catch blocks in GitPlugin
- [ ] Errors appear in DiagnosticCollector
- [ ] User sees helpful message when git access fails

## Dependencies

REG-78 (infrastructure complete)
