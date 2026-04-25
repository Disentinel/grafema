# User Request: REG-288

**Title:** AST: Track UpdateExpression modifications

**Description:**
Gap: `i++`, `--count` not tracked as mutations.

**Example:**
```javascript
let count = 0;
count++;  // MODIFIES edge missing
```

**Acceptance Criteria:**
- [ ] MODIFIES edge for ++/-- expressions
- [ ] Track both prefix and postfix

**Linear URL:** https://linear.app/reginaflow/issue/REG-288/ast-track-updateexpression-modifications

**Status:** In Progress
