# REG-362: Add pre-release hooks to enforce CHANGELOG updates

## Goal

Prevent releases without documentation updates by adding automated checks.

## Acceptance Criteria

- Pre-release hook checks if CHANGELOG.md was updated
- Hook runs before `pnpm publish` or release script
- Clear error message when CHANGELOG is not updated
- Option to bypass for hotfixes (with explicit flag)

## Notes

Reference: grafema-release skill already handles version bumping - this should integrate with that workflow.
