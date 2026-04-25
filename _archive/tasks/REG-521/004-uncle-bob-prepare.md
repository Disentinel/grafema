# Uncle Bob PREPARE Review: REG-521

## Review Date: 2026-02-19

## Overview

Reviewing files that will be modified for REG-521 (add MCP tools for listing/describing validation/enrichment plugins). Three new tools will be added: `list_validation_plugins`, `list_enrichment_plugins`, and `describe_plugin`.

---

## File: packages/mcp/src/definitions.ts

**File size:** 669 lines — **CRITICAL (MUST SPLIT)**
**Methods to modify:** TOOLS array (adding 3 new definitions, ~30-50 lines each)

### File-level

**CRITICAL ISSUE:** This file is already at 669 lines and contains 27 tool definitions. After adding 3 new tool definitions (each ~30-50 lines based on existing patterns), the file will exceed **750+ lines**, which is WELL beyond the 700-line hard limit.

**Root cause:** Single file doing one thing (tool definitions) but at massive scale. The TOOLS array is linear and contains all definitions inline.

**MUST SPLIT before implementation:**

**Recommendation:** Split by functional domain into separate files:

```
packages/mcp/src/definitions/
  index.ts              # Re-export all tools
  query-tools.ts        # query_graph, find_calls, find_nodes, trace_*
  analysis-tools.ts     # discover_services, analyze_project, get_analysis_status, get_stats, get_schema
  guarantee-tools.ts    # create_guarantee, list_guarantees, check_guarantees, delete_guarantee
  context-tools.ts      # get_function_details, get_context, get_file_overview, find_guards
  project-tools.ts      # read_project_structure, write_config
  plugin-tools.ts       # NEW: list_validation_plugins, list_enrichment_plugins, describe_plugin
  utility-tools.ts      # get_coverage, get_documentation, report_issue
```

Each domain file exports its own array, `index.ts` concatenates them:

```typescript
export const TOOLS: ToolDefinition[] = [
  ...QUERY_TOOLS,
  ...ANALYSIS_TOOLS,
  ...GUARANTEE_TOOLS,
  ...CONTEXT_TOOLS,
  ...PROJECT_TOOLS,
  ...PLUGIN_TOOLS,
  ...UTILITY_TOOLS,
];
```

**Risk if not split:** Adding 3 tools now pushes to ~750+ lines. Future additions (REG-522, etc.) will make this file completely unmaintainable. This violates the 700-line HARD LIMIT and creates technical debt.

**Risk:** HIGH
**Estimated scope:** 100-150 lines affected (split into 7-8 files)

---

## File: packages/mcp/src/server.ts

**File size:** 254 lines — **OK**
**Methods to modify:** CallToolRequestSchema handler switch statement (lines 128-228)

### File-level

**Size:** OK (254 lines, well below 500-line threshold)

### Method-level: handleToolCalls (lines 117-242)

**Current state:**
- Method length: 125 lines — **REFACTOR RECOMMENDED**
- Switch statement: 20 cases — manageable but growing
- Pattern: Each case calls `asArgs<T>()` + handler function

**Analysis:**
- Adding 3 new cases adds ~15 lines (3 cases × 5 lines each)
- Final size: ~140 lines (still acceptable)
- Pattern is consistent and clear

**Recommendation:** SKIP refactor for now.

**Rationale:** While 125-line method is long, the switch statement is the right pattern here (router/dispatcher). Alternatives (map of handlers) would add complexity without clarity gain. The pattern is mechanical and easy to follow.

**Future trigger:** If switch exceeds 30 cases or 150 lines, THEN refactor to handler map.

**Risk:** LOW
**Estimated scope:** +15 lines (3 new cases)

---

## File: packages/mcp/src/types.ts

**File size:** 348 lines — **OK**
**Methods to modify:** None (adding 3 new interfaces)

### File-level

**Size:** OK (348 lines, well below 500-line threshold)

### Method-level

**Change:** Add 3 new argument interfaces:

```typescript
export interface ListValidationPluginsArgs { /* empty or limit/offset */ }
export interface ListEnrichmentPluginsArgs { /* empty or limit/offset */ }
export interface DescribePluginArgs { name: string }
```

**Analysis:**
- Each interface: 2-5 lines
- Total addition: ~10-15 lines
- Final size: ~360 lines (OK)

**Recommendation:** SKIP refactor

**Risk:** LOW
**Estimated scope:** +10-15 lines

---

## File: packages/mcp/src/handlers/index.ts

**File size:** 14 lines — **OK**
**Methods to modify:** None (adding 1 new export)

### File-level

**Size:** OK (14 lines, trivial barrel file)

### Method-level

**Change:** Add export for new plugin-handlers.ts:

```typescript
export { handleListValidationPlugins, handleListEnrichmentPlugins, handleDescribePlugin } from './plugin-handlers.js';
```

**Recommendation:** SKIP refactor

**Risk:** LOW
**Estimated scope:** +1 line

---

## Reference Files (patterns to follow)

### File: packages/mcp/src/handlers/context-handlers.ts

**File size:** 410 lines — **OK**
**Purpose:** Reference for handler implementation pattern

**Pattern observed:**
- Import shared utilities (`ensureAnalyzed`, `textResult`, `errorResult`)
- Type-safe args from types.ts
- Core logic delegated to @grafema/core
- Rich formatted output (text summary + JSON)
- Error handling with helpful messages

**Methods reviewed:**
- `handleGetFunctionDetails` (lines 39-118): 80 lines — OK
- `handleGetContext` (lines 165-297): 133 lines — **borderline long**, but justified (complex formatting logic)
- `handleGetFileOverview` (lines 301-410): 110 lines — OK

**Pattern to follow for new plugin handlers:**
1. Call `ensureAnalyzed()` (even though plugins don't need graph, this keeps pattern consistent)
2. Validate args
3. Call core API (`listValidationPlugins()`, `describePlugin()`, etc.)
4. Format output (text summary + JSON)
5. Handle errors gracefully

**Risk assessment:** Methods are at upper bound of acceptable length but justified by formatting complexity.

### File: packages/mcp/src/handlers/query-handlers.ts

**File size:** 321 lines — **OK**
**Purpose:** Reference for simpler handler pattern

**Methods reviewed:**
- `handleQueryGraph` (lines 29-152): 124 lines — OK (includes explain logic + error hints)
- `handleFindCalls` (lines 154-228): 75 lines — OK
- `formatExplainOutput` (lines 230-274): 45 lines — OK
- `handleFindNodes` (lines 276-325): 50 lines — OK

**Pattern observed:**
- Pagination logic extracted to shared utils
- Rich error messages with hints
- Consistent pagination info formatting

---

## Summary of Required Changes

### BLOCKING (must do before implementation):

1. **Split definitions.ts** into domain-based modules (packages/mcp/src/definitions/*.ts)
   - Estimated effort: 2-3 hours
   - Risk if skipped: Technical debt, file exceeds 750 lines, violates hard limits
   - Priority: CRITICAL

### NON-BLOCKING (OK to proceed as-is):

1. **server.ts switch statement** — add 3 cases (~15 lines) — OK
2. **types.ts** — add 3 interfaces (~10 lines) — OK
3. **handlers/index.ts** — add 1 export line — OK
4. **Create new handlers/plugin-handlers.ts** — follow context-handlers.ts pattern

---

## Implementation Recommendations for Rob

After definitions.ts is split:

1. **Create new file:** `packages/mcp/src/definitions/plugin-tools.ts`
   ```typescript
   export const PLUGIN_TOOLS: ToolDefinition[] = [
     { name: 'list_validation_plugins', ... },
     { name: 'list_enrichment_plugins', ... },
     { name: 'describe_plugin', ... },
   ];
   ```

2. **Update definitions/index.ts** to include PLUGIN_TOOLS in concatenation

3. **Create handlers/plugin-handlers.ts** following context-handlers.ts pattern

4. **Add 3 type interfaces** to types.ts

5. **Add 3 switch cases** to server.ts

6. **Add 1 export** to handlers/index.ts

---

## Risk Assessment

| File | Current Lines | After Changes | Risk | Action |
|------|--------------|---------------|------|--------|
| definitions.ts | 669 | 750+ | **CRITICAL** | **MUST SPLIT** |
| server.ts | 254 | ~270 | LOW | Proceed |
| types.ts | 348 | ~360 | LOW | Proceed |
| handlers/index.ts | 14 | 15 | LOW | Proceed |
| handlers/plugin-handlers.ts | 0 (new) | ~200-300 | LOW | Create following pattern |

**Overall Risk:** HIGH (due to definitions.ts)

**Recommendation:** REFACTOR definitions.ts BEFORE implementing REG-521. This is not optional — it's a prerequisite to healthy codebase growth.
