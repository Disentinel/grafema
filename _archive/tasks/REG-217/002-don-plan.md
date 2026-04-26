# Don Melton Analysis: REG-217

## 1. CURRENT WARNING SYSTEM ANALYSIS

### Where Warnings Come From
- **DiagnosticCollector** (`packages/core/src/diagnostics/DiagnosticCollector.ts`): Central collection point for all errors/warnings during analysis
  - Collects from PluginResult.errors[] from each plugin
  - Converts both GrafemaError instances (rich metadata) and plain Error instances (generic) into unified Diagnostic entries
  - Stores diagnostics with: code, severity (fatal|error|warning|info), message, file, line, phase, plugin, timestamp, suggestion

- **Validation Plugins** (`packages/core/src/plugins/validation/`): Generate warning-level diagnostics
  - GraphConnectivityValidator: Reports unreachable nodes (disconnected graph)
  - CallResolverValidator: Reports unresolved function calls
  - DataFlowValidator: Reports missing assignments and broken variable references
  - Others: EvalBanValidator, SQLInjectionValidator, ShadowingDetector, NodeCreationValidator, TypeScriptDeadCodeValidator

### How Warnings Flow to CLI Output
1. **Orchestrator** collects diagnostics in internal DiagnosticCollector as plugins run
2. **analyze.ts** retrieves diagnostics via `orchestrator.getDiagnostics()`
3. **DiagnosticReporter** formats the output using `reporter.summary()` method
4. Currently `summary()` returns just "Warnings: X, Errors: Y" format

### Current Limitation
The `reporter.summary()` method (line 61-81 in DiagnosticReporter.ts) only counts by severity level:
```typescript
const parts: string[] = [];
if (stats.fatal > 0) parts.push(`Fatal: ${stats.fatal}`);
if (stats.errors > 0) parts.push(`Errors: ${stats.errors}`);
if (stats.warnings > 0) parts.push(`Warnings: ${stats.warnings}`);
return parts.join(', ');
```

**This provides no actionable detail** - users can't tell what types of warnings exist.

## 2. EXISTING PATTERNS & INFRASTRUCTURE

### Diagnostic Codes by Type
From validators, we already have semantic categories:
- **Connectivity**: `DISCONNECTED_NODES` (GraphConnectivityValidator)
- **Call Resolution**: `UNRESOLVED_FUNCTION_CALL` (CallResolverValidator)
- **Data Flow**: `MISSING_ASSIGNMENT`, `BROKEN_REFERENCE`, `NO_LEAF_NODE` (DataFlowValidator)
- **Code Quality**: Various from other validators

### Available Diagnostic Metadata
Each Diagnostic has:
- `code`: Machine-readable category identifier
- `severity`: fatal|error|warning|info
- `phase`: DISCOVERY|INDEXING|ANALYSIS|ENRICHMENT|VALIDATION
- `plugin`: Which plugin created it
- `message`, `file`, `line`: Details about affected code
- `suggestion`: Actionable guidance

### CLI Command Infrastructure
- **check.ts** exists and already supports:
  - `grafema check --guarantee=<name>` for built-in validators
  - `grafema check --list-guarantees` to show available checks
  - Both human and JSON output formats
  - Freshness checking with reanalysis capability

## 3. HIGH-LEVEL APPROACH

### Phase 1: Enhance DiagnosticReporter.summary()
Make the summary method generate categorized output:

**New method: `categorizedSummary()`**
- Group diagnostics by diagnostic code
- Count per category
- Return formatted text with actionable commands

**Example output format:**
```
Warnings: 8
  - 172 disconnected nodes (run `grafema check connectivity`)
  - 987 unresolved calls (run `grafema check calls`)
  - 45 missing assignments (run `grafema check dataflow`)

Run `grafema check --all` for full diagnostics.
```

### Phase 2: Add Check Subcommands
Extend check command with detailed diagnostic subcommands:
- `grafema check connectivity` → show disconnected nodes
- `grafema check calls` → show unresolved calls
- `grafema check dataflow` → show missing assignments
- `grafema check --all` → show all categorized issues

### Phase 3: Integrate into Analyze Output
Modify analyze.ts:
1. Replace `reporter.summary()` with `reporter.categorizedSummary()`
2. Add suggestion text: "Run `grafema check --all` for full diagnostics"

## 4. SCOPE BOUNDARIES

**IN SCOPE:**
- Enhance DiagnosticReporter with new `categorizedSummary()` method
- Map diagnostic codes to user-friendly category names
- Add check command subcommands for each category
- Update analyze command output
- Write tests for new methods

**OUT OF SCOPE:**
- REG-213 (doctor command - higher level)
- Changing diagnostic collection in validators
- Database schema changes

## 5. ARCHITECTURAL DECISIONS

### Why Group by Code, Not Severity?
- Severity is already in basic summary (Warnings: X)
- Users need to distinguish between "disconnected nodes" vs "unresolved calls"
- Both typically have severity=warning but very different remediation paths

### Why Keep summary() Instead of Replacing?
- Maintains backward compatibility with JSON output
- Different callers may need different formats
- DiagnosticReporter is used by both CLI and MCP

## 6. RISKS & CONCERNS

1. **Over-categorization**: Start with top 3-4 categories, others under `--advanced`
2. **Performance with many diagnostics**: Use Map-based grouping
3. **Stale diagnostics**: Ensure `--clear` flag properly clears diagnostics

## 7. CONCLUSION

This is a **presentation layer** enhancement. The diagnostic infrastructure is already solid:
- DiagnosticCollector properly captures all warnings
- Diagnostic codes are semantic and categorizable
- Check command pattern is established
- No changes needed to core graph or validation logic

**This aligns with project vision:** "AI should query the graph, not read code" - the check subcommands are graph queries.
