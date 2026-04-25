## User Request: REG-211

**Source:** Linear issue REG-211
**Date:** 2026-02-19

### Request

Fix false positive "unused interfaces" warning for TypeScript.

TypeScriptDeadCodeValidator reports 76 interfaces as "unused" (no implementations), but this is a false positive because TypeScript interfaces are structural types — they don't require `implements` keyword.

### Solution

Option A (recommended): Remove the validator. Better no warning than a wrong warning.

### Acceptance Criteria

- No false positive warnings for TypeScript interfaces
- Validator removed
- Tests pass
