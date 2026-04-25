# REG-236: FunctionCallResolver: Add maxDepth boundary test for re-export chains

## Summary

Add test case that verifies the maxDepth safety limit (10 hops) works correctly.

## Background

During REG-232 review, Kevlin noted missing edge case test for the depth limit boundary condition.

## Implementation

Add test that creates an 11-hop re-export chain and verifies:

1. No crash/infinite loop
2. Chain is skipped (counted as broken)
3. No CALLS edge created

## Related

* REG-232 (introduced maxDepth limit)
