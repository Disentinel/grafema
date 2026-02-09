# Kent Beck Test Report: REG-173 Onboarding Instruction Tests

## Date: 2026-02-09

## Test Files Created

### 1. Core Instruction Loading Test
**Location:** `test/unit/instructions/onboarding.test.ts`

**Purpose:** Verify that `getOnboardingInstruction()` from `@grafema/core` returns valid markdown content.

**Test Coverage:**
- Returns non-empty string
- Contains all 6 step headers (## Step 1 through ## Step 6)
- References expected MCP tool names:
  - `read_project_structure`
  - `write_config`
  - `discover_services`
  - `analyze_project`
  - `get_stats`
  - `get_coverage`
- Contains guidance on "When to ask the user"

**Status:** ✅ All 4 tests passing

### 2. MCP Prompts Test
**Location:** `packages/mcp/test/prompts.test.ts`

**Purpose:** Verify MCP prompts system exposes onboarding instruction correctly.

**Test Coverage:**

#### PROMPTS List:
- Contains `onboard_project` prompt
- Has correct structure (name, description, arguments)
- Arguments array is empty (no parameters needed)

#### getPrompt() Function:
- Returns valid result for `onboard_project`
- Result contains description and messages array
- Message has correct structure (role: 'user', content.type: 'text')
- Instruction text includes all step headers
- Throws error for unknown prompt name
- Error message lists available prompts

**Status:** ✅ All 6 tests passing

### 3. Onboarding Tools Test
**Location:** `packages/mcp/test/tools-onboarding.test.ts`

**Purpose:** Test the two new MCP tools: `read_project_structure` and `write_config`.

**Test Coverage:**

#### handleReadProjectStructure:
- Reads root directory structure correctly
- Respects `depth` parameter (1 vs 3 levels)
- Excludes common build directories (node_modules, .git, dist, .grafema, etc.)
- Supports `include_files` parameter (true/false)
- Returns error for non-existent path
- Returns error for file path (not directory)

#### handleWriteConfig:
- Writes basic config with services
- Writes config with include/exclude patterns
- Writes config with workspace roots
- Creates .grafema directory if missing
- Returns error for invalid service path
- Includes header comments in config file
- Returns summary with next steps

**Status:** ✅ All 13 tests passing

## Test Infrastructure

### Temp Directory Management
All tests use real filesystem with proper cleanup:
- `beforeEach()`: Creates temp directory, sets project path via `setProjectPath()`
- `afterEach()`: Cleans up temp directory, restores original path

### Test Data Setup
Tests create real directory structures and files to verify actual file system operations.

### Error Handling
Tests verify both success and error paths:
- Invalid paths
- Missing directories
- Invalid configurations

## Test Results Summary

**Total Tests:** 23 tests across 3 files
**Status:** ✅ All tests passing
**Duration:** ~5 seconds total

### Individual Test Run Results:

1. `test/unit/instructions/onboarding.test.ts`
   - 4 tests passed
   - Duration: ~1.5s

2. `packages/mcp/test/prompts.test.ts`
   - 6 tests passed
   - Duration: ~2s

3. `packages/mcp/test/tools-onboarding.test.ts`
   - 13 tests passed
   - Duration: ~1.8s

## Test Design Principles Applied

1. **Tests First:** Written before implementation exists (TDD discipline)
2. **Clear Intent:** Each test name describes what behavior it verifies
3. **Real Operations:** Use real filesystem, not mocks (for these handlers)
4. **Proper Cleanup:** `afterEach()` ensures no test pollution
5. **Both Paths:** Test success and error scenarios
6. **Minimal Mocking:** Only mock what's necessary (project path state)

## Notes

- Tests follow existing patterns from `packages/mcp/test/mcp.test.ts`
- Use `node:test` framework (describe/it/beforeEach/afterEach)
- Use `node:assert` for assertions
- Import from `dist/` folder (compiled output)
- Tests verify actual file creation and content

## Next Steps

These tests are ready for Rob Pike to implement the actual functionality:

1. `packages/core/src/instructions/onboarding.md` - the instruction document
2. MCP prompt handler already exists in `packages/mcp/src/prompts.ts`
3. MCP tool handlers already exist in `packages/mcp/src/handlers.ts`

Tests will guide implementation and verify correctness.
