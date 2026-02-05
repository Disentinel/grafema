# REG-332: Improve strict mode error UX

## Background

REG-330 implemented strict mode for fail-fast debugging. Steve Jobs demo review identified several UX improvements needed.

## Issues to Address

### Critical (from Steve's demo review):

1. **Error message duplication** - Same error appears twice in output (once in main message, once in [FATAL] line). Should show once in a structured format.
2. **Context-aware suggestions** - Current suggestion "Check if class is imported" is generic. Should analyze WHY resolution failed and suggest specific fix.
3. **Show the chain** - If `user.processData()` fails because `getUser()` return is unknown, error should show that chain, not just the leaf failure.
4. **Add escape hatch** - Allow suppressing specific errors (e.g., `// grafema-ignore-next-line`)

### Nice to have:

* Better error codes (subcodes like STRICT_UNKNOWN_RETURN_TYPE)
* Link to documentation in error messages
* Progressive disclosure (brief default, `--verbose` for full trace)

## Related

* Parent: REG-330 (strict mode implementation)
* Steve's full demo report: `_tasks/REG-330/010-steve-demo.md`
