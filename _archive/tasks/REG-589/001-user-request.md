# REG-589: core-v2: ArgumentParameterLinker — link call arguments to function parameters

## Source
Linear issue REG-589

## Request
v2 creates PASSES_ARGUMENT and RECEIVES_ARGUMENT edges but doesn't link them positionally (arg[0] → param[0]). v1's `ArgumentParameterLinker` enricher does this.

## Approach
Add to `resolve.ts` post-file stage: for each resolved CALLS edge, match PASSES_ARGUMENT edges from the CALL node with RECEIVES_ARGUMENT edges on the target FUNCTION by position.

## Acceptance Criteria
- Positional argument-to-parameter linking works for direct calls
- Works for method calls where target is resolved
- Golden test coverage for the linking
