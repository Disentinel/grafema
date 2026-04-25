# Vadim Decision: REG-149

**Date:** 2026-02-06
**Decision:** FULL SCOPE, CLEAN APPROACH

## User Directive

> Going with Full. Just leave unclear cases for my review. Just use the vision and clear code practices as guideline for the rest. I don't care how long it will take, we need to approach this clean and right.

## Interpretation

1. **Full scope** - Fix all 824 violations properly
2. **Clean approach** - No eslint-disable hacks, no shortcuts
3. **Unclear cases** - Flag for user review rather than guessing
4. **Timeline** - Quality over speed, take the time needed
5. **Guidelines** - Project vision ("AI should query the graph, not read code") and clean code practices

## Execution Plan

1. Re-enable type-aware ESLint rules
2. Fix violations systematically by pattern/package
3. Flag genuinely unclear cases for review
4. Test continuously
5. Enable rules as `error` when done
