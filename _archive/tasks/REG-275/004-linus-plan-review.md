# Linus Torvalds: Plan Review for REG-275

## VERDICT: APPROVED WITH MINOR CONCERNS

The plans are solid. Don and Joel did good work here. The core architectural decision - introducing BRANCH as a proper abstraction instead of shoehorning everything into SCOPE - is the right call.

---

## 1. Right Abstraction?

**YES.** BRANCH is the correct abstraction.

Currently, `SwitchStatement` creates a `SCOPE` with `scopeType: 'switch-case'`. This is wrong. A switch statement is not fundamentally a scope - it's a branching construct. The current implementation mixes concerns.

`BRANCH` + `CASE` properly separates:
- Control flow structure (BRANCH)
- Individual branch targets (CASE)
- Containment (SCOPE for if/else blocks is separate concern)

The plan correctly removes the SCOPE creation for switch statements. This is breaking backward compatibility, but it's the right thing to do. Anyone who was relying on `SCOPE#switch-case` was relying on a wrong abstraction.

---

## 2. Complete?

**YES.** All acceptance criteria are covered:

- [x] BRANCH node created for SwitchStatement
- [x] HAS_CONDITION edge to discriminant
- [x] HAS_CASE edges to each case clause
- [x] Track fall-through patterns (via `fallsThrough` boolean)

The plan also handles edge cases: empty cases, `isEmpty` flag, multiple terminators, nested switches.

---

## 3. Consistent with Existing Patterns?

**MOSTLY.** The plan follows established patterns:

- Node contracts (BranchNode, CaseNode) follow ScopeNode pattern exactly
- GraphBuilder integration follows existing buffer pattern
- Test file location and structure matches `object-property-edges.test.ts`
- Semantic ID generation uses existing `computeSemanticId`

**One consistency issue:** The current `IfStatement` still creates `SCOPE` with `scopeType: 'if_statement'`. Don's plan mentions this should be a separate task (REG-276). This is fine - we're not doing scope creep. But make sure IfStatement becomes BRANCH in that future task to keep the abstraction consistent.

---

## 4. Over-engineered?

**NO.** The plan is appropriately sized for what it does.

Some might argue the fall-through detection is complex (checking nested blocks, if-else termination). But this complexity is necessary - incorrect fall-through detection would be worse than no detection at all.

The `branchType: 'switch' | 'if' | 'ternary'` field is forward-looking but doesn't add implementation cost now. Good.

---

## 5. Under-engineered?

**ONE MINOR CONCERN:**

Joel's plan has the discriminant EXPRESSION node being created in `bufferDiscriminantExpressions()` by parsing the ID string:

```typescript
// Parse the ID to extract expression type
const parts = branch.discriminantExpressionId.split(':');
const expressionType = parts[2];  // {file}:EXPRESSION:{type}:{line}:{col}
```

This is fragile. ID format is an implementation detail. If we change the format, this breaks.

**Better approach:** Store the necessary metadata in `BranchInfo` directly:
```typescript
interface BranchInfo {
  // ... existing fields
  discriminantExpressionId?: string;
  discriminantExpressionType?: string;  // ADD THIS
  discriminantLine?: number;             // ADD THIS
  discriminantColumn?: number;           // ADD THIS
}
```

Then `bufferDiscriminantExpressions()` doesn't need to parse anything. It just uses the stored metadata.

This is a **minor concern** - not blocking. The current approach will work. But it's a code smell.

---

## 6. Future-proof for IfStatement?

**YES.** The `branchType: 'switch' | 'if' | 'ternary'` field is designed for this.

When IfStatement gets the same treatment:
- BRANCH node with `branchType: 'if'`
- HAS_CONDITION edge to the condition expression
- HAS_CASE could be repurposed for if/else blocks (or we use different edges)

The plan doesn't lock us into switch-only thinking.

---

## Summary of Concerns

1. **Minor:** Discriminant metadata parsing from ID string is fragile. Consider storing metadata directly.

2. **Not a concern but noting:** Fall-through detection via boolean is simpler than FALLS_THROUGH edge. This is the right call for v1. If we need control flow graphs later, we can add edges.

3. **Documentation note:** The decision to replace SCOPE#switch-case (not supplement) should be clearly documented. Anyone doing a `git bisect` needs to understand this was intentional.

---

## Final Verdict

**APPROVED.** Proceed with implementation.

Don's architecture is clean. Joel's tech spec is detailed enough for Kent and Rob to execute without guessing. The test cases cover the important scenarios.

The one minor improvement (storing discriminant metadata directly) can be addressed during implementation if Rob thinks it's worth it. It's not a blocker.

Good work. Now go build it.
