# REG-274: AST Track IfStatement (BRANCH node)

## Gap

`IfStatement` AST node is completely ignored - no graph representation.

## Example

```javascript
if (user.isAdmin) {
  deleteAll();
} else {
  showError();
}
```

## Expected Graph

```
BRANCH#if:file.js:1
  ├─[HAS_CONDITION]→ EXPRESSION(user.isAdmin)
  ├─[HAS_CONSEQUENT]→ SCOPE#then
  └─[HAS_ALTERNATE]→ SCOPE#else
```

## User Impact

* Can't answer "what conditions guard this operation?"
* Can't detect dead code in branches
* Can't calculate cyclomatic complexity

## Acceptance Criteria

- [ ] BRANCH node created for each IfStatement
- [ ] HAS_CONDITION edge to condition expression
- [ ] HAS_CONSEQUENT edge to then-branch scope
- [ ] HAS_ALTERNATE edge to else-branch scope (if exists)
