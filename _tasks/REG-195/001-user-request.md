# REG-195: Grafema 0.2 — Code Coverage

## Goal

Set up code coverage measurement for Grafema — track how well our code is covered by tests.

## Plan

1. **Tooling Setup**
   - Connect c8 or nyc to tests
   - Configure Istanbul JSON output + console report
2. **CI Integration**
   - Coverage report on every PR
   - Minimum coverage threshold (start with current level)
3. **Reporting**
   - Badge in README
   - Codecov/Coveralls or just CI artifacts

## Acceptance Criteria

- [ ] `npm test` outputs coverage
- [ ] CI checks coverage
- [ ] Badge in README
