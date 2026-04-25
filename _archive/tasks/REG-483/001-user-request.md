# REG-483: Remove redundant GraphBuilder buffer layer

## Request

Memory grows gradually during analysis phase. Root cause: triple buffering — JSASTAnalyzer collections → GraphBuilder `_nodeBuffer`/`_edgeBuffer` → RFDBClient `_batchNodes`/`_batchEdges`. GraphBuilder buffer is redundant since PhaseRunner already wraps plugins in `beginBatch()`/`commitBatch()`.

## Context

Discovered during REG-477 investigation. Analysis from earlier conversation confirmed:
- GraphBuilder buffer is vestigial
- Only 1 usage of `findBufferedNode` (ModuleRuntimeBuilder.ts:405)
- All other GraphBuilder responsibilities (field stripping, domain builder orchestration, scope resolution) are independent of the buffer
