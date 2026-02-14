# REG-286: AST: Track ThrowStatement systematically

## Status Check

Ticket was in "In Review" but work is incomplete.

## What exists already
- `hasThrow: boolean` in `controlFlow` metadata on function nodes
- ThrowStatement visitor in JSASTAnalyzer that sets the flag
- REG-311 extended with async rejection tracking (`canReject`, `hasAsyncThrow`)
- `THROWS` edge type defined in `edges.ts` and `typeValidation.ts`

## What's missing (acceptance criteria)
1. **THROWS edge** from containing function to throw expression — NOT created
2. **Track error class/type** — only partial (async throw in REG-311)
3. **`canThrow: true` metadata** — exists as `controlFlow.hasThrow` but not as top-level `canThrow`

## Task
Complete the implementation: create THROWS edges, track error types for all throws (not just async), ensure canThrow metadata is set.
