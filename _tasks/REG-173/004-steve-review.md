# Steve Jobs -- Plan Review for REG-173

## Verdict: APPROVE

---

## Vision Alignment

This feature directly serves the core thesis: **"AI should query the graph, not read code."**

Right now, `grafema init` produces a generic config and hopes auto-discovery at analyze-time does the right thing. When it doesn't, the user is lost -- they have no idea what went wrong, no way to fix it, no understanding of what Grafema saw. That is the opposite of the Grafema promise.

This plan fixes the gap correctly: it surfaces Grafema's detection intelligence to the user BEFORE analysis. The user sees what the tool sees, confirms it, and the result is a deterministic, editable config. This is the kind of feature that makes users trust the tool. It is also critical for the onboarding story -- if users can't get through `grafema init` on their real project, they will never reach the graph.

The plan is NOT about building flashy UI. It is about making the existing detection infrastructure **visible and controllable**. That is the right instinct.

---

## Architecture Assessment

The three-layer separation is correct and well-motivated:

1. **ProjectScanner** (core, pure detection) -- no graph dependency, no UI dependency. Produces structured data. MCP server can use it. CLI can use it. Tests can use it.

2. **InitFlow** (cli, Ink-based interactive) -- pure presentation over scanner results. Separation of concerns is clean.

3. **ConfigWriter** (cli, writes config.yaml) -- the artifact is config, not graph nodes. This is the right call: `init` produces config, `analyze` produces graph. Mixing them would be a design error.

**Verified claims:**
- `detectWorkspaceType()` exists at `packages/core/src/plugins/discovery/workspaces/detector.ts:26` -- confirmed.
- `parsePnpmWorkspace()`, `parseNpmWorkspace()`, `parseLernaConfig()` exist in `workspaces/parsers.ts` at lines 25, 50, 86 -- confirmed.
- `resolveWorkspacePackages()` exists in `workspaces/globResolver.ts:40` -- confirmed.
- `resolveSourceEntrypoint()` exists in `resolveSourceEntrypoint.ts:75` -- confirmed.
- `TS_SOURCE_CANDIDATES` is indeed a private `const` at line 37 -- confirmed. The one-word change to `export const` is accurate and minimal.
- `WorkspaceDiscovery` (priority 110) and `SimpleProjectDiscovery` (priority 50) already use ALL these utilities -- confirmed. The plan genuinely reuses existing infrastructure.
- `ServiceDefinition` type exists in `@grafema/types` at `packages/types/src/plugins.ts:213` with `{ name, path, entryPoint? }` -- confirmed.
- Orchestrator at line 696 checks `this.configServices.length > 0` and skips discovery plugins -- confirmed. Writing services to config.yaml will work correctly with the existing Orchestrator.
- `DEFAULT_CONFIG.services` is `[]` (line 145 of ConfigLoader.ts) -- confirmed.
- `explore.tsx` uses Ink with `useInput`, `useState`, `render()` from ink -- confirmed. The Ink TUI pattern is proven in this codebase.
- `ink` v6 and `react` v19 are in `packages/cli/package.json` -- confirmed.
- Current `init.ts` is 199 lines with raw `readline.createInterface` -- confirmed.
- `ink-spinner` is NOT a dependency (despite Joel's claim on line 322 that it's "already implicit in Ink") -- it is NOT implicit. The codebase has a custom `Spinner` class in `packages/cli/src/utils/spinner.ts` using raw stdout, not Ink-based. **Minor factual error, but Joel corrects this by saying "or build a minimal component."** The existing `Spinner` utility or simple Ink Text animation will work fine.
- `ink-select-input` and `ink-multi-select` are NOT dependencies -- confirmed. Joel correctly identifies this and proposes building minimal components (~140 lines total). This is the right call.
- `packages/core/src/discovery/` directory does NOT exist yet -- confirmed. It will be created.
- `packages/cli/src/components/` directory does NOT exist yet -- confirmed. It will be created.
- Existing `cli-init.test.ts` exists with subprocess-based testing pattern -- confirmed.
- `WorkspaceDiscovery.test.ts` uses `mkdtempSync` + fixture creation pattern -- confirmed. Tests follow this pattern.

**No parallel detection system.** The plan explicitly reuses the utility functions from `workspaces/detector.ts`, `workspaces/parsers.ts`, `workspaces/globResolver.ts`, and `resolveSourceEntrypoint.ts`. `WorkspaceDiscovery` and `SimpleProjectDiscovery` plugins already call these same functions to create graph nodes -- `ProjectScanner` calls them to produce structured data WITHOUT graph nodes. This is the correct extraction.

---

## Complexity Check

**PASSED.**

| Operation | Complexity | Acceptable? |
|---|---|---|
| `detectWorkspaceType()` | O(1) -- 4 file existence checks | Yes |
| `parse*Workspace()` | O(1) -- parse single config file | Yes |
| `resolveWorkspacePackages()` | O(P * G) -- P patterns, G matching dirs, maxDepth=10 | Yes, bounded |
| `buildDetectedService()` per service | O(1) -- read package.json, ~20 entry candidates | Yes |
| `classifyService()` per service | O(1) -- ~15 checks against dependency keys | Yes |
| `estimateFileCount()` per service | O(F) -- depth-limited to 5 | Yes, bounded |
| **Full scan (200-package workspace)** | **O(S * F_avg)** -- ~10K fs ops | **Yes, <2s on SSD** |

No brute-force scanning of graph nodes. No O(n) over all nodes. This is filesystem-only, depth-bounded, and runs once during init (not during analysis). The iteration space is well-defined and bounded.

The `estimateFileCount()` is the only potentially slow operation, and it is bounded by `maxDepth=5` and skips `node_modules`, `dist`, `build`, and hidden dirs. For a typical package with 100 files, this is <10ms. For 200 packages, total is <2s. This is acceptable for a one-time init operation.

---

## Concerns

### Concern 1: `ink-spinner` claim is wrong
Joel states `ink-spinner` is "already implicit in Ink" (line 322). It is not. Ink does not bundle `ink-spinner`. The codebase uses a custom raw-stdout `Spinner` class. This is a factual error but has **zero architectural impact** -- the scanning step can use a simple Ink `<Text>` with "Analyzing..." text, or the existing `Spinner` utility, or a trivial animation component. Not a blocker.

### Concern 2: Large monorepo UX (200+ packages)
The plan acknowledges this risk (Don's Risk 5, Joel's section 3.5). Joel proposes grouping by directory prefix when >50 services. This is a reasonable mitigation for the init flow. The grouping logic is simple and contained. I would have preferred a hard cap (e.g., show top 50 by file count, offer "show all") but grouping works.

### Concern 3: Symlink handling in `globResolver.ts`
Joel claims line 221-228 uses `lstatSync` and "explicitly rejects symlinks" -- **confirmed**, `isDirectory()` returns `stat.isDirectory() && !stat.isSymbolicLink()`. However, `lstatSync` returns `isDirectory() = false` for symlinks (since lstat doesn't follow them), and `isSymbolicLink() = true`. So the `&& !stat.isSymbolicLink()` is redundant but not harmful. ProjectScanner inherits this behavior via `resolveWorkspacePackages()`. No issue.

### Concern 4: No `--reconfigure` in scope
The plan defers `grafema init --reconfigure` to future work. This is acceptable for the initial implementation. Users can delete `.grafema/config.yaml` and re-run `init`. Not a gap that defeats the feature's purpose.

---

## Specific Feedback

### Don's Plan (002-don-plan.md)

**Line 101:** "Create a lightweight `ProjectScanner` class in `packages/core`" -- Correct. The word "lightweight" is important. This should not become a god class.

**Line 109:** "For simple selection prompts, we can use `ink-select-input` (or build a minimal select component)" -- Joel correctly resolves this as "build minimal components." Good.

**Line 267:** Risk 1 mitigation says "fall back to `readline`-based prompts." Joel's spec says "fall back to raw `process.stdout.write` + `process.stdin` with ANSI escape codes (not readline -- that only supports line-by-line)." Joel is more precise here. Neither should be needed -- the `explore.tsx` pattern proves Ink works.

**Lines 330-331:** "We may need `ink-select-input`... check if it exists" -- Resolved by Joel. Not needed.

### Joel's Plan (003-joel-tech-plan.md)

**Line 67:** Import paths use `.js` extension (e.g., `../plugins/discovery/workspaces/detector.js`) -- This matches the codebase convention for ESM imports. Correct.

**Line 147:** "Currently this is a private `const`. We need to **export** it (minor modification to `resolveSourceEntrypoint.ts` line 37: change from unexported const to `export const`)." -- Verified. Correct line reference. Minimal change.

**Line 148:** The plan says `TS_SOURCE_CANDIDATES` needs to be exported. Note that `as const` means the type is `readonly` tuple. This is fine for the consumer -- it only reads the array, never mutates it.

**Lines 252-253:** Plan correctly identifies `packages/core/src/index.ts` needs a new export near line 268. Current file has exports up to ~line 90 (based on search results), so the exact line number may be wrong, but the concept is right -- add `ProjectScanner` export to the barrel file.

**Line 322:** "Show Ink `<Spinner>` (from `ink-spinner`, already implicit in Ink)" -- Factually wrong as noted above. `ink-spinner` is not part of Ink. Not a design issue.

**Line 365:** "Both components follow the exact pattern from `explore.tsx` (lines 189-337)" -- Verified. `useInput` at line 189, arrow key handling throughout, `useState` for state management. The pattern is proven.

**Line 477:** Joel claims symlinks are handled by `lstatSync` at lines 221-228 -- Verified correct. The isDirectory check explicitly rejects symlinks.

**Lines 686-687:** Mocking strategy says "No interactive tests" for Ink and tests via `--yes` mode. This is pragmatic and correct. Testing interactive Ink components would require `ink-testing-library` which is an unnecessary dependency. Testing via `--yes` + subprocess covers the important behavior.

---

## Verdict Rationale

I am approving this plan because:

1. **It does the right thing.** Instead of patching auto-detection or adding heuristics to a silent process, it makes the detection visible and controllable. This is a fundamental UX improvement, not a hack.

2. **It reuses existing infrastructure.** The plan does NOT create a parallel detection system. Every utility function (`detectWorkspaceType`, `parsePnpmWorkspace`, `resolveWorkspacePackages`, `resolveSourceEntrypoint`) is already proven in production. `ProjectScanner` is a thin composition layer over these existing functions.

3. **The separation of concerns is correct.** Scanner (core, pure) / UI (cli, Ink) / Config (cli, YAML write). Each layer has a clear responsibility. The scanner is independently testable and reusable by MCP.

4. **Complexity is bounded.** No graph scanning, no O(n) over all nodes, filesystem-only with depth limits. The one-time init operation taking <2s for 200-package monorepos is acceptable.

5. **The scope is tight.** Include/exclude patterns, framework-specific plugin suggestions, and MCP integration are explicitly deferred. The plan focuses on the core value: interactive service discovery during init.

6. **No "MVP limitations" that defeat the purpose.** The feature works for single projects, pnpm workspaces, npm/yarn workspaces, and lerna. That covers the vast majority of JS/TS project structures. The heuristic service descriptions might be wrong sometimes, but they are informational only -- the user confirms. Entry point detection covers ~20 well-known patterns. The 5% of custom projects that don't match can edit `config.yaml` manually.

7. **Test strategy is sound.** TDD with real filesystem fixtures (matching existing `WorkspaceDiscovery.test.ts` patterns), subprocess-based CLI integration tests, and coverage of edge cases.

The two factual errors (ink-spinner claim, core/index.ts line number) are trivial and do not affect the architecture. The plan is well-researched, well-structured, and correctly leverages the existing codebase.

**Escalate to Vadim for final approval.**
