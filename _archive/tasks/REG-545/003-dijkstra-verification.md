## Dijkstra Plan Verification — REG-545

**Verdict: APPROVE with conditions**

One structural gap requires a test fix. All other issues are either acceptable (documented conservative tradeoffs) or correctly handled. The implementation as described in the plan will not produce false HANDLED_BY edges, but it will miss certain true positives that are explicitly acknowledged as deferred. The re-export external branch has an uncovered gap that needs a test and a plan clarification. Details follow.

---

### Table 1: Import Type Enumeration

| Import form | FCR indexes? | Gets HANDLED_BY from FCR? | Gets HANDLED_BY from ECR? |
|---|---|---|---|
| `import { x } from './utils'` (named, relative) | YES | YES — Change 2D | NO — ECR skips relative |
| `import x from './utils'` (default, relative) | YES | YES | NO |
| `import { x as y } from './utils'` (aliased, relative) | YES — indexed by `local` = `y` | YES | NO |
| `import * as ns from './utils'` (namespace, relative) | YES | NO — method call, `object` field set, skipped | NO |
| `import { x } from 'lib'` (named, external) | NO | NO | YES |
| `import x from 'lib'` (default, external) | NO | NO | YES |
| `import * as ns from 'lib'` (namespace, external) | NO | NO | NO — method call skipped |
| `import type { x } from 'lib'` (type-only, external) | YES (FCR does NOT check `importBinding`) | **GAP 1 — see below** | NO — ECR guards with `importBinding !== 'type'` |
| `const x = require('lib')` (CJS) | Out of scope | n/a | n/a |
| `import('lib')` (dynamic) | Out of scope | n/a | n/a |

**GAP 1: FunctionCallResolver will create HANDLED_BY for `import type` relative imports.**

ExternalCallResolver explicitly guards against type-only imports (line 274: `if (imp.importBinding !== 'type')`). FunctionCallResolver's Change 2D does NOT have this guard. A `import type { Foo } from './types'` with a CALL of same local name in the same file would produce a spurious HANDLED_BY edge.

The plan's test cases do not include a test for type-only relative imports. This gap is undetected. **Must fix.**

---

### Table 2: CALL Node Type Enumeration

| CALL node type | FCR behavior | ECR behavior |
|---|---|---|
| Direct call, no `object` field, no CALLS edge | Processed → CALLS + (new) HANDLED_BY | Processed if still no CALLS after FCR |
| Method call (`object` field set) | Skipped | Skipped |
| Already has CALLS edge | Skipped | Skipped |
| Dynamic call (`isDynamic`) | Falls through to `missingImport` skip | Returns unresolved |
| No `name` or no `file` | `continue` | Returns unresolved |

**HANDLED_BY duplication:** FunctionCallResolver (relative) and ExternalCallResolver (external) are mutually exclusive by design. ECR's `collectUnresolvedCalls` skips calls that already have CALLS edges. No duplicates possible. Confirmed.

---

### Table 3: Shadowing Enumeration — Conservative Set Approach

| Shadow scenario | Plan's behavior | Correct behavior | Issue? |
|---|---|---|---|
| VARIABLE in same function, CALL in same function | Blocked | Should block | Correct |
| PARAMETER in containing function | Not blocked — plan only queries VARIABLE + CONSTANT | Should block | **GAP 2** |
| VARIABLE in function `f`, CALL in unrelated function `g` (same file) | Blocked (flat set) | Should NOT block | Known false negative, documented |
| CONSTANT in inner block, CALL at top-level | Blocked (flat set) | Should NOT block | Known false negative, documented |

**GAP 2: PARAMETER nodes not included in shadow index.**

If the Grafema AST creates PARAMETER nodes for function parameters (not VARIABLE), those are missed. A call inside a function using a parameter with same name as an import will incorrectly get HANDLED_BY. The plan must verify what node type the AST creates for function parameters and add PARAMETER to the shadow index query if needed.

**Non-gap — conservative cross-function shadowing:** The flat `Set<file:name>` suppresses HANDLED_BY when a VARIABLE exists anywhere in the file with matching name. This is a documented false negative (conservative, never creates wrong edges). Acceptable for stated scope.

---

### Table 4: Re-export Chain — `imp` Variable Availability

| Question | Answer |
|---|---|
| Is `imp` in scope at Change 2D (direct function case)? | YES — declared at line 182, in scope through loop body |
| Is `imp` in scope at Change 2E (external re-export branch)? | YES — same scope |
| When FCR resolves via re-export to external module, does ECR also run? | NO — FCR creates CALLS edge, ECR skips calls with CALLS edges |
| Will ECR create HANDLED_BY for re-export-to-external calls? | NO — ECR is skipped because CALLS already exists |
| Will Change 2E correctly create HANDLED_BY for these calls? | YES — but there is no test for this case |

**GAP 3: No test for external re-export branch HANDLED_BY (Change 2E).**

The plan's three Phase 1A test cases don't cover: "CALL to function resolved through re-export chain terminating at external module — gets HANDLED_BY to the relative IMPORT node in the calling file." Without a test, this code path is untested.

---

### Table 5: ExternalCallResolver Registration

| What | Current state | Plan fix | Correct? |
|---|---|---|---|
| ECR in `builtinPlugins.ts` | ABSENT | Change 3A: add entry | YES |
| ECR in `createTestOrchestrator.js` | ABSENT | Change 3B: add FCR + ECR | YES |
| Execution order FCR before ECR | Enforced by ECR `dependencies: ['FunctionCallResolver']` | Plan relies on this | YES |

---

### Table 6: Preconditions

| Precondition | Verified? |
|---|---|
| IMPORT nodes exist before ENRICHMENT | YES — ANALYSIS phase |
| IMPORTS_FROM edges exist before FCR | YES — FCR depends on ImportExportLinker |
| FCR runs before ECR | YES — ECR declares dependency on FCR |
| VARIABLE/CONSTANT nodes exist before FCR shadow index | YES — ANALYSIS phase |
| PARAMETER nodes are VARIABLE or CONSTANT in graph | **UNVERIFIED — GAP 2** |
| `importBinding` field on IMPORT nodes for type-only | YES — ECR uses it; FCR ignores it (GAP 1) |

---

### Summary of Gaps

**GAP 1 — Missing type-only import guard in Changes 2D and 2E.**
Must add `imp.importBinding !== 'type'` guard (matching ECR's existing pattern) and add a test for `import type { x } from './local'` where `x()` is called — expected: no HANDLED_BY.

**GAP 2 — PARAMETER nodes not in shadow index.**
Must verify node type for function parameters. Add PARAMETER to the shadow query if they are not represented as VARIABLE.

**GAP 3 — No test for external re-export branch HANDLED_BY.**
Must add test: CALL resolved through relative re-export chain terminating at external module → HANDLED_BY to the calling file's IMPORT node.

**Non-gaps (accepted):**
- Conservative cross-function shadowing false negatives — documented, deferred
- `imp` scope availability — confirmed correct
- HANDLED_BY duplication — impossible by design
