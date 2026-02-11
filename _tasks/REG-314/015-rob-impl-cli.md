# Rob Pike - CLI Implementation Report

## Task
Add `grafema annotate --suggest` CLI command for Phase 4.

## Files Created/Modified

### `/packages/cli/src/commands/annotate.ts` (new)
- Command implementation with options: `--suggest`, `--json`, `--verbose`, `--top`
- Human-readable output format matching spec
- JSON output for programmatic use
- Proper error handling for missing database

### `/packages/cli/src/cli.ts` (modified)
- Added import for annotateCommand
- Registered command in program

## Implementation Notes

1. **Followed coverage.ts pattern** - Same structure for project resolution, backend connection, error handling

2. **Output format** - Matches spec with:
   - Coverage summary
   - Ranked unannotated patterns
   - File summaries (compact by default, detailed with --verbose)
   - Suggested config snippet for patterns with heuristic matches

3. **Options**:
   - `-s, --suggest` - Required flag to show suggestions
   - `-j, --json` - JSON output
   - `-v, --verbose` - Show all files instead of summary
   - `-t, --top <n>` - Limit results (default: 10)

## Testing

1. **Build**: Passes
2. **Unit tests**: All 19 AnnotationSuggester tests pass
3. **Manual test (no loops)**:
```
Cardinality Annotation Suggestions
===================================

Coverage: 0 of 0 loops have cardinality (0%)

No loops found in the graph.
```

4. **JSON output**: Works correctly
5. **Help output**: Shows all options and examples

## Commit
```
feat(cli): Add 'grafema annotate --suggest' command

Shows which functions should be annotated with cardinality
based on loop iteration frequency.

REG-314
```

## Status
Complete. Ready for review.
