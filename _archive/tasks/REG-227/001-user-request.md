# REG-227: Update CallResolverValidator for new resolution types

## Summary

Update validator to understand new resolution types and only report truly unresolved calls.

## Background

Current validator reports ALL CALL_SITE nodes without CALLS edges as violations. After implementing FunctionCallResolver (REG-225) and ExternalCallResolver (REG-226), we need to update the validator.

See REG-206 design doc for full analysis.

## Implementation

Update CallResolverValidator to:

1. Not report external package calls as violations (they have CALLS to EXTERNAL_MODULE)
2. Not report built-in calls as violations (they have `resolutionType='builtin'`)
3. Only report `resolutionType='unresolved'` as warnings (not errors)
4. Update summary statistics

## New Datalog Rules

```prolog
% Only report truly unresolved calls
violation(X) :- node(X, "CALL"),
               attr(X, "resolutionType", "unresolved").

% Don't report these as violations
ok(X) :- node(X, "CALL"), attr(X, "resolutionType", "builtin").
ok(X) :- node(X, "CALL"), edge(X, _, "CALLS").
```

## Acceptance Criteria

- [ ] External calls (with edge to EXTERNAL_MODULE) not reported
- [ ] Built-in calls not reported
- [ ] Only truly unresolved calls reported as warnings
- [ ] Summary shows breakdown by resolution type

## Dependencies

* REG-225 (FunctionCallResolver) - Done
* REG-226 (ExternalCallResolver) - Done
