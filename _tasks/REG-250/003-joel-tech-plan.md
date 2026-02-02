# Joel Spolsky Tech Plan: REG-250

## Summary

The `datalogQuery()` API only supports single atoms, not conjunctions. When a user queries `node(X, "http:request"), attr(X, "url", U)`, the system can't parse it, or if using rules, the variable U isn't properly returned in results.

## Root Cause

1. `parse_atom()` can only parse single atoms, not comma-separated conjunctions
2. `execute_datalog_query()` calls `parse_atom()` directly
3. There's no API to evaluate a conjunction of atoms directly

## Implementation Plan

### Step 1: Add `parse_query()` function

In `packages/rfdb-server/src/datalog/parser.rs`:

```rust
/// Parse a query (conjunction of literals)
/// Supports: single atom OR comma-separated atoms
pub fn parse_query(input: &str) -> Result<Vec<Literal>, ParseError> {
    let mut parser = Parser::new(input);
    let mut body = Vec::new();

    body.push(parser.parse_literal()?);

    loop {
        parser.skip_whitespace();
        if parser.peek() == Some(',') {
            parser.expect(",")?;
            body.push(parser.parse_literal()?);
        } else {
            break;
        }
    }

    Ok(body)
}
```

### Step 2: Add `eval_query()` method to Evaluator

In `packages/rfdb-server/src/datalog/eval.rs`:

```rust
/// Evaluate a query (conjunction of literals)
/// Returns all bindings satisfying the conjunction
pub fn eval_query(&self, literals: &[Literal]) -> Vec<Bindings> {
    let mut current = vec![Bindings::new()];

    for literal in literals {
        let mut next = vec![];

        for bindings in &current {
            match literal {
                Literal::Positive(atom) => {
                    let substituted = self.substitute_atom(atom, bindings);
                    let results = self.eval_atom(&substituted);

                    for result in results {
                        if let Some(merged) = bindings.extend(&result) {
                            next.push(merged);
                        }
                    }
                }
                Literal::Negative(atom) => {
                    let substituted = self.substitute_atom(atom, bindings);
                    let results = self.eval_atom(&substituted);

                    if results.is_empty() {
                        next.push(bindings.clone());
                    }
                }
            }
        }

        current = next;
        if current.is_empty() {
            break;
        }
    }

    current
}
```

### Step 3: Update `execute_datalog_query()` in server

In `packages/rfdb-server/src/bin/rfdb_server.rs`:

```rust
fn execute_datalog_query(
    engine: &GraphEngine,
    query_source: &str,
) -> std::result::Result<Vec<WireViolation>, String> {
    // Parse the query (supports single atom or conjunction)
    let literals = parse_query(query_source)
        .map_err(|e| format!("Datalog query parse error: {}", e))?;

    // Create evaluator
    let evaluator = Evaluator::new(engine);

    // Execute query
    let bindings = evaluator.eval_query(&literals);

    // Convert to wire format
    let results: Vec<WireViolation> = bindings.into_iter()
        .map(|b| {
            let mut map = std::collections::HashMap::new();
            for (k, v) in b.iter() {
                map.insert(k.clone(), v.as_str());
            }
            WireViolation { bindings: map }
        })
        .collect();

    Ok(results)
}
```

### Step 4: Tests

Add tests in `packages/rfdb-server/src/datalog/tests.rs`:

1. Test `parse_query()` with single atom
2. Test `parse_query()` with conjunction
3. Test `eval_query()` with single atom
4. Test `eval_query()` with conjunction (node + attr)
5. Test that attr() value binding works in conjunction

## Files to Modify

1. `packages/rfdb-server/src/datalog/parser.rs` - Add `parse_query()`
2. `packages/rfdb-server/src/datalog/eval.rs` - Add `eval_query()`
3. `packages/rfdb-server/src/datalog/mod.rs` - Export new functions
4. `packages/rfdb-server/src/bin/rfdb_server.rs` - Update `execute_datalog_query()`
5. `packages/rfdb-server/src/datalog/tests.rs` - Add tests

## Acceptance Criteria

- [x] `attr(Node, Key, Value)` binds and returns `Value`
- [ ] Conjunction queries work: `node(X, "type"), attr(X, "url", U)`
- [ ] Single atom queries still work (backward compatibility)
- [ ] Test coverage for attr() predicate with value binding
