# User Request: REG-121

## Linear Issue

**ID:** REG-121
**Title:** Cross-file edges not recreated after graph.clear()

## Problem Description

When using `--clear` flag, edges between files (like IMPORTS_FROM, DEPENDS_ON) may not be properly recreated.

## Source

Discovered during REG-118 fix. Test "should recreate cross-file edges on re-analysis" fails.

## Expected Behavior

After `grafema analyze --clear`:
- All cross-file edges should be recreated
- IMPORTS_FROM edges should connect IMPORT nodes to EXPORT nodes in other files

## Actual Behavior

Some cross-file edges are missing after clear + re-analysis.

## Investigation Needed

- Check edge creation timing in GraphBuilder
- Verify IMPORTS_FROM edge logic
- May be related to async edge creation after node flush
