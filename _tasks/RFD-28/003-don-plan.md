# Don's Plan: RFD-28 — Unified `executeDatalog` Endpoint

## Overview

Add `ExecuteDatalog` command to RFDB server with smart auto-detection:
- If input has rules → load them, query head predicate of first rule
- If input is a conjunction → evaluate directly
- Backward compatible — existing endpoints stay

## Server Changes (Rust)

**File:** `packages/rfdb-server/src/bin/rfdb_server.rs`

### 1. Add `ExecuteDatalog` to Request enum (~line 202)

```rust
ExecuteDatalog {
    source: String,
},
```

### 2. Add handler (~line 1170)

```rust
Request::ExecuteDatalog { source } => {
    with_engine_read(session, |engine| {
        match execute_datalog(engine, &source) {
            Ok(results) => Response::DatalogResults { results },
            Err(e) => Response::Error { error: e },
        }
    })
}
```

### 3. Add unified execution function (~line 1677)

```rust
fn execute_datalog(
    engine: &dyn GraphStore,
    source: &str,
) -> std::result::Result<Vec<WireViolation>, String> {
    // Try parsing as program first
    if let Ok(program) = parse_program(source) {
        if !program.rules().is_empty() {
            let mut evaluator = Evaluator::new(engine);
            for rule in program.rules() {
                evaluator.add_rule(rule.clone());
            }
            // Auto-detect head predicate of first rule
            let head = program.rules()[0].head();
            let bindings = evaluator.query(head);
            // ... convert to WireViolation format
            return Ok(results);
        }
    }

    // Fall back to direct query
    let literals = parse_query(source)
        .map_err(|e| format!("Datalog parse error: {}", e))?;
    let evaluator = Evaluator::new(engine);
    let bindings = evaluator.eval_query(&literals);
    // ... convert to WireViolation format
    Ok(results)
}
```

**Reuses:** existing `Response::DatalogResults`, existing parser functions, existing evaluator.

## Client Changes (TypeScript)

### 4. RFDBClient method (`packages/rfdb/ts/client.ts` ~line 866)

```typescript
async executeDatalog(source: string): Promise<DatalogResult[]> {
  const response = await this._send('executeDatalog', { source });
  return (response as { results?: DatalogResult[] }).results || [];
}
```

### 5. Backend wrapper (`packages/core/src/storage/backends/RFDBServerBackend.ts` ~line 736)

```typescript
async executeDatalog(source: string) {
  const results = await this.client.executeDatalog(source);
  return results.map(r => ({
    bindings: Object.entries(r.bindings).map(([name, value]) => ({ name, value }))
  }));
}
```

### 6. Optional: CLI simplification (`packages/cli/src/commands/query.ts` ~line 1019)

Replace `query.includes(':-')` routing with single `backend.executeDatalog(query)` call.

## Test Plan

Extend `test/unit/RawDatalogQueryRouting.test.js`:
- Direct queries produce same results as `datalogQuery`
- Rule-based programs produce same results as `checkGuarantee`
- Custom head predicate (`mycheck(X, N) :- ...`) works
- Empty programs fall back to direct query

## Effort

~70 lines Rust + ~20 lines TypeScript + ~40 lines tests = 2-3 hours.

## Risk

Low — purely additive, uses existing infrastructure, backward compatible.
