# User Request

## Linear Issues

### REG-151: Migrate SQLInjectionValidator to use reportIssue()

Follow-up from REG-95 (ISSUE nodes). SQLInjectionValidator currently detects SQL injection vulnerabilities but only logs them - they're not persisted in the graph.

**Goal:** Migrate SQLInjectionValidator to use `context.reportIssue()` to persist issue nodes.

**Changes Required:**
1. Update SQLInjectionValidator metadata to declare created nodes: `['issue:security']`
2. When vulnerability detected, call `context.reportIssue()`
3. Track issue node count for PluginResult
4. Maintain backward compatibility (still return issues in metadata)

**Acceptance Criteria:**
- SQLInjectionValidator creates ISSUE nodes
- AFFECTS edges connect issues to target CALL nodes
- Existing tests still pass
- Issues queryable via `queryNodes({ nodeType: 'issue:security' })`

### REG-150: RFDB: Issue lifecycle management (clearing on reanalysis)

Currently issues accumulate forever, duplicates prevented by hash-based IDs.

**Problem:** When a file is reanalyzed:
- Old issues for that file should be cleared
- New issues should be created fresh
- This matches MODULE nodes behavior

**Options:**
1. Orchestrator automatic clearing - When file is reanalyzed, delete all issue:* nodes for that file first
2. Per-plugin responsibility - Each plugin deletes its old issues before creating new ones
3. Keep accumulation - Issues accumulate, rely on hash-based IDs for deduplication (current)

**Acceptance Criteria:**
- Define issue lifecycle strategy
- Implement clearing mechanism
- Test that reanalysis clears stale issues
- Test that new issues are created with same IDs (deterministic)

## Approach

These issues are related:
- REG-150 defines the infrastructure/lifecycle rules
- REG-151 uses that infrastructure in a concrete plugin

Should tackle REG-150 first to establish the pattern, then REG-151 as the first consumer.
