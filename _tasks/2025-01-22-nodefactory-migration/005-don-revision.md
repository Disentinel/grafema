# Don Melton - Plan Revision (REG-98)

Addressing Linus's review concerns.

---

## 1. ID Format Decision

**Decision: COLON everywhere. No exceptions.**

Regular nodes: `${file}:${TYPE}:${name}:${line}`
Singletons: `${TYPE}:${singleton_name}`

Examples:
- `src/app.js:CLASS:UserService:42`
- `EXTERNAL_STDIO:__stdio__`
- `NET_REQUEST:__network__`

---

## 2. EXPRESSION Node - IN SCOPE

**Findings:**
- GraphBuilder creates EXPRESSION nodes inline (lines 809-829)
- VariableVisitor creates EXPRESSION nodes inline
- CallExpressionVisitor creates EXPRESSION nodes inline
- NO contract or factory method exists

**Decision: Add to scope.** Create `ExpressionNode.ts` and `NodeFactory.createExpression()`.

---

## 3. OBJECT_LITERAL/ARRAY_LITERAL - REMOVE FROM SCOPE

**Findings:**
- `ObjectLiteralNode.ts` EXISTS
- `ArrayLiteralNode.ts` EXISTS
- `NodeFactory.createObjectLiteral()` EXISTS
- `NodeFactory.createArrayLiteral()` EXISTS

**Decision: Already done. Remove from scope.**

---

## 4. ExportNode.source Field - ADD IT

Current `ExportNode.ts` lacks `source` field. Re-exports need it.

**Decision: Add `source` field to ExportNode contract.**

---

## 5. Backward Compatibility - CLEAR DATA

**Decision: Clear all data before migration.**

- Development phase, no production deployments
- Migration script overhead not justified
- Add to release notes: "Run `grafema db:clear` before upgrading"

---

## Updated Scope

**In scope (12 factory methods):**
1. createClass()
2. createExport() (+ add source field)
3. createExternalModule() - new contract
4. createType() - new contract
5. createEnum() - new contract
6. createInterface() - new contract
7. createExternalInterface()
8. createExternalClass()
9. createDecorator() - new contract
10. createExpression() - new contract (ADDED)
11. createNetStdio() (fix ID)
12. createNetRequest() - new contract

**Removed from scope:**
- OBJECT_LITERAL (already done)
- ARRAY_LITERAL (already done)

---

## Files to Create (7)
- ExternalModuleNode.ts
- InterfaceNode.ts
- TypeNode.ts
- EnumNode.ts
- DecoratorNode.ts
- NetRequestNode.ts
- ExpressionNode.ts (ADDED)

## Files to Modify (5)
- nodes/index.ts
- nodes/ClassNode.ts
- nodes/ExternalStdioNode.ts (fix ID)
- nodes/ExportNode.ts (add source)
- NodeFactory.ts (add 12 methods)

---

**READY FOR LINUS RE-REVIEW**
