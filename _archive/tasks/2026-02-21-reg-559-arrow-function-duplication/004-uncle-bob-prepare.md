## Uncle Bob PREPARE Review: FunctionVisitor.ts

**File size:** 450 lines — OK (under 500 limit)
**Methods to modify:** ArrowFunctionExpression handler — 93 lines (lines 292–384)

**File-level:**
- OK. The file has a single clear responsibility: detecting and recording FUNCTION and SCOPE nodes for function declarations and arrow functions. It does not stray into unrelated concerns.
- Helper functions (`extractParamInfo`, `extractReturnType`, `extractJsdocSummary`, `buildSignature`, `generateAnonymousName`) are defined as closures inside `getHandlers()`. They belong to the handler logic and do not pollute the class namespace. This is acceptable, though it does inflate the method count of `getHandlers()`.

**Method-level:** FunctionVisitor.ts:ArrowFunctionExpression
- **Length:** 93 lines (lines 292–384). This exceeds the 50-line candidate threshold.
- **Readability:** The handler is readable. Its structure is sequential and well-commented: extract name → generate ID → extract type info → push FunctionInfo → extract type parameters → enter scope → create parameters → create SCOPE node → detect Promise executor → analyze body → exit scope → skip. Each block has a clear comment label.
- **Duplication note (REG-559 context):** The handler duplicates nearly the same structure as `FunctionDeclaration` (lines 212–289, which is 78 lines). The two handlers share: IdGenerator construction, extractParamInfo/extractReturnType/extractJsdocSummary/buildSignature calls, FunctionInfo push, typeParameters extraction block, enterScope, createParameterNodes, SCOPE push, analyzeFunctionBody, exitScope, path.skip(). This structural duplication is the root of the REG-559 issue.
- **Proposed guard (getFunctionParent() check):** A 3-line guard at the top of `ArrowFunctionExpression` (before line 293) fits cleanly. The existing name-resolution block (lines 301–308) is the natural insertion point: the guard should come just before or replace that block. The handler's sequential structure accommodates the addition without disruption.

**Recommendation:** SKIP dedicated refactoring sprint for this method before REG-559 implementation.

**Rationale:** The handler is 93 lines — above the 50-line candidate threshold, but the length is caused by the duplicated boilerplate that REG-559 itself is partially addressing. Extracting a shared helper for the common FunctionDeclaration/ArrowFunctionExpression logic would be the correct long-term fix, but that is a separate, larger refactor. The REG-559 change is additive (3 lines at the top of the handler) and does not increase the handler's complexity or length meaningfully. Doing a structural de-duplication refactor now would expand scope substantially and risk introducing bugs in the FunctionDeclaration path.

**If a cleanup is wanted before the change:** The only safe, in-scope micro-cleanup would be to extract the type-parameters block (lines 338–351, 14 lines) into a private method `extractAndPushTypeParameters(node, functionId, ...)` — this block is copy-pasted identically in both handlers. This is optional and not required for REG-559 to proceed.

**Risk:** LOW
**Estimated scope:** 3 lines added at the top of `ArrowFunctionExpression` handler (before existing name-resolution logic, around line 293). No existing lines removed or reordered.
