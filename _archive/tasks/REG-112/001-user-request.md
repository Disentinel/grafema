# REG-112: Remove or simplify NodeCreationValidator after migration

## Task Description

After NodeFactory migration is complete, the NodeCreationValidator becomes unnecessary if TypeScript types enforce factory usage.

## Decision Required

After migration:

1. **Remove entirely** - if TypeScript enforcement is sufficient
2. **Simplify** - keep as runtime double-check for external code

## Context

The validator was created to catch violations, but:
- It couldn't catch them due to architectural mismatch (see REG-98)
- TypeScript types now enforce factory usage at compile time
- Runtime validation may still be useful for external/dynamic code

## Related Issues

- REG-98: Parent issue for NodeFactory migration
- REG-99 to REG-110: Individual node type migrations
- REG-111: TypeScript type enforcement

## Linear URL

https://linear.app/reginaflow/issue/REG-112/remove-or-simplify-nodecreationvalidator-after-migration
