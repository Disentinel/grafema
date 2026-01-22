# REG-129: Migrate TYPE and ENUM to use colon separator ID format

## Context

After REG-103, INTERFACE nodes now use the standard `:` separator ID format (`{file}:INTERFACE:{name}:{line}`).

TYPE and ENUM still use the legacy `#` separator format in TypeScriptVisitor.ts.

## Task

Migrate TYPE and ENUM node creation to:

1. Use the standard `:` separator format
2. Potentially create TypeNode and EnumNode factories (like InterfaceNode)

## Consistency

All node types should use the same ID format for consistency. Current state:

* CLASS: `:` format (migrated)
* INTERFACE: `:` format (REG-103)
* IMPORT: `:` format (migrated)
* EXPORT: `:` format (migrated)
* TYPE: `#` format (needs migration)
* ENUM: `#` format (needs migration)

## Files

* `packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts` - lines ~193 (TYPE), ~221 (ENUM)
