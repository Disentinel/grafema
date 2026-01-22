# Joel Spolsky - Technical Implementation Plan: REG-125

## Executive Summary

This document expands Don's high-level plan into actionable implementation steps for showing semantic IDs by default in CLI output. The goal is to make semantic IDs the primary identifier in all human-readable output while maintaining backward compatibility for JSON output.

## 1. New Utility Function: formatNodeDisplay()

### Location
Create new file: `/packages/cli/src/utils/formatNode.ts`

### Function Signature

```typescript
/**
 * Format options for node display
 */
export interface FormatNodeOptions {
  /** Project path for relative file paths */
  projectPath: string;
  /** Include location line (default: true) */
  showLocation?: boolean;
  /** Prefix for each line (default: '') */
  indent?: string;
}

/**
 * Node information required for display
 */
export interface DisplayableNode {
  id: string;          // Semantic ID (e.g., "auth/service.ts->AuthService->FUNCTION->authenticate")
  type: string;        // Node type (e.g., "FUNCTION", "CLASS")
  name: string;        // Human-readable name
  file: string;        // Absolute file path
  line?: number;       // Line number (optional)
}

/**
 * Format a node for primary display (multi-line)
 *
 * Output format:
 *   [FUNCTION] authenticate
 *     ID: auth/service.ts->AuthService->FUNCTION->authenticate
 *     Location: auth/service.ts:42
 */
export function formatNodeDisplay(
  node: DisplayableNode,
  options: FormatNodeOptions
): string;

/**
 * Format a node for inline display in lists (single line with semantic ID)
 *
 * Output format:
 *   auth/service.ts->AuthService->FUNCTION->authenticate
 */
export function formatNodeInline(
  node: DisplayableNode,
  options: FormatNodeOptions
): string;

/**
 * Format file location relative to project
 */
export function formatLocation(
  file: string | undefined,
  line: number | undefined,
  projectPath: string
): string;
```

### Implementation

```typescript
import { relative } from 'path';

export interface FormatNodeOptions {
  projectPath: string;
  showLocation?: boolean;
  indent?: string;
}

export interface DisplayableNode {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
}

/**
 * Format a node for primary display (multi-line)
 */
export function formatNodeDisplay(
  node: DisplayableNode,
  options: FormatNodeOptions
): string {
  const { projectPath, showLocation = true, indent = '' } = options;
  const lines: string[] = [];

  // Line 1: [TYPE] name
  lines.push(`${indent}[${node.type}] ${node.name}`);

  // Line 2: ID (semantic ID)
  lines.push(`${indent}  ID: ${node.id}`);

  // Line 3: Location (optional)
  if (showLocation) {
    const loc = formatLocation(node.file, node.line, projectPath);
    if (loc) {
      lines.push(`${indent}  Location: ${loc}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format a node for inline display in lists (semantic ID only)
 */
export function formatNodeInline(node: DisplayableNode): string {
  return node.id;
}

/**
 * Format file location relative to project
 */
export function formatLocation(
  file: string | undefined,
  line: number | undefined,
  projectPath: string
): string {
  if (!file) return '';
  const relPath = relative(projectPath, file);
  return line ? `${relPath}:${line}` : relPath;
}
```

---

## 2. Command Modifications

### 2.1 query.ts Modifications

**File:** `/packages/cli/src/commands/query.ts`

#### Change 1: Import the new utility (add at top, around line 14)

**Before:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
```

**After:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../utils/formatNode.js';
```

#### Change 2: Update displayNode() function (lines 397-403)

**Before:**
```typescript
function displayNode(node: NodeInfo, projectPath: string): void {
  const loc = formatLocation(node.file, node.line, projectPath);
  console.log(`Found: ${node.name} (${node.type})`);
  if (loc) {
    console.log(`Location: ${loc}`);
  }
}
```

**After:**
```typescript
function displayNode(node: NodeInfo, projectPath: string): void {
  console.log(formatNodeDisplay(node, { projectPath }));
}
```

#### Change 3: Update caller display (lines 98-104)

**Before:**
```typescript
if (callers.length > 0) {
  console.log('');
  console.log(`Called by (${callers.length}${callers.length >= 5 ? '+' : ''}):`);
  for (const caller of callers) {
    const loc = formatLocation(caller.file, caller.line, projectPath);
    console.log(`  ← ${caller.name} (${loc})`);
  }
}
```

**After:**
```typescript
if (callers.length > 0) {
  console.log('');
  console.log(`Called by (${callers.length}${callers.length >= 5 ? '+' : ''}):`);
  for (const caller of callers) {
    console.log(`  <- ${formatNodeInline(caller)}`);
  }
}
```

#### Change 4: Update callee display (lines 107-114)

**Before:**
```typescript
if (callees.length > 0) {
  console.log('');
  console.log(`Calls (${callees.length}${callees.length >= 5 ? '+' : ''}):`);
  for (const callee of callees) {
    const loc = formatLocation(callee.file, callee.line, projectPath);
    console.log(`  → ${callee.name} (${loc})`);
  }
}
```

**After:**
```typescript
if (callees.length > 0) {
  console.log('');
  console.log(`Calls (${callees.length}${callees.length >= 5 ? '+' : ''}):`);
  for (const callee of callees) {
    console.log(`  -> ${formatNodeInline(callee)}`);
  }
}
```

#### Change 5: Remove local formatLocation() function (lines 408-416)

**Action:** Delete the local `formatLocation()` function since we now import it from the utility.

---

### 2.2 trace.ts Modifications

**File:** `/packages/cli/src/commands/trace.ts`

#### Change 1: Import the new utility (add at top, around line 12)

**Before:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
```

**After:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../utils/formatNode.js';
```

#### Change 2: Update variable display (lines 72-76)

**Before:**
```typescript
for (const variable of variables) {
  const loc = formatLocation(variable.file, variable.line, projectPath);
  console.log(`Variable: ${variable.name}`);
  console.log(`Location: ${loc}`);
  console.log('');
```

**After:**
```typescript
for (const variable of variables) {
  console.log(formatNodeDisplay(variable, { projectPath }));
  console.log('');
```

#### Change 3: Update displayTrace() function (lines 322-340)

**Before:**
```typescript
function displayTrace(trace: TraceStep[], projectPath: string, indent: string): void {
  // Group by depth
  const byDepth = new Map<number, TraceStep[]>();
  for (const step of trace) {
    if (!byDepth.has(step.depth)) {
      byDepth.set(step.depth, []);
    }
    byDepth.get(step.depth)!.push(step);
  }

  for (const [depth, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    for (const step of steps) {
      const loc = formatLocation(step.node.file, step.node.line, projectPath);
      const arrow = step.edgeType === 'ASSIGNED_FROM' ? '←' : '⟵';
      const valueStr = step.node.value !== undefined ? ` = ${JSON.stringify(step.node.value)}` : '';
      console.log(`${indent}${arrow} ${step.node.name || step.node.type}${valueStr} (${loc})`);
    }
  }
}
```

**After:**
```typescript
function displayTrace(trace: TraceStep[], projectPath: string, indent: string): void {
  // Group by depth
  const byDepth = new Map<number, TraceStep[]>();
  for (const step of trace) {
    if (!byDepth.has(step.depth)) {
      byDepth.set(step.depth, []);
    }
    byDepth.get(step.depth)!.push(step);
  }

  for (const [depth, steps] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    for (const step of steps) {
      const arrow = step.edgeType === 'ASSIGNED_FROM' ? '<-' : '<-';
      const valueStr = step.node.value !== undefined ? ` = ${JSON.stringify(step.node.value)}` : '';
      console.log(`${indent}${arrow} ${step.node.name || step.node.type} (${step.node.type})${valueStr}`);
      console.log(`${indent}   ${step.node.id}`);
    }
  }
}
```

#### Change 4: Remove local formatLocation() function (lines 345-349)

**Action:** Delete the local `formatLocation()` function since we now import it from the utility.

---

### 2.3 impact.ts Modifications

**File:** `/packages/cli/src/commands/impact.ts`

#### Change 1: Import the new utility (add at top, around line 12)

**Before:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
```

**After:**
```typescript
import { RFDBServerBackend } from '@grafema/core';
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../utils/formatNode.js';
```

#### Change 2: Update displayImpact() target display (lines 329-334)

**Before:**
```typescript
function displayImpact(impact: ImpactResult, projectPath: string): void {
  const loc = formatLocation(impact.target.file, impact.target.line, projectPath);

  console.log(`Target: ${impact.target.name} (${impact.target.type})`);
  console.log(`Location: ${loc}`);
  console.log('');
```

**After:**
```typescript
function displayImpact(impact: ImpactResult, projectPath: string): void {
  console.log(formatNodeDisplay(impact.target, { projectPath }));
  console.log('');
```

#### Change 3: Update direct callers display (lines 344-352)

**Before:**
```typescript
if (impact.directCallers.length > 0) {
  console.log('Direct callers:');
  for (const caller of impact.directCallers.slice(0, 10)) {
    const callerLoc = formatLocation(caller.file, caller.line, projectPath);
    console.log(`  ← ${caller.name} (${callerLoc})`);
  }
  if (impact.directCallers.length > 10) {
    console.log(`  ... and ${impact.directCallers.length - 10} more`);
  }
  console.log('');
}
```

**After:**
```typescript
if (impact.directCallers.length > 0) {
  console.log('Direct callers:');
  for (const caller of impact.directCallers.slice(0, 10)) {
    console.log(`  <- ${formatNodeInline(caller)}`);
  }
  if (impact.directCallers.length > 10) {
    console.log(`  ... and ${impact.directCallers.length - 10} more`);
  }
  console.log('');
}
```

#### Change 4: Remove local formatLocation() function (lines 407-411)

**Action:** Delete the local `formatLocation()` function since we now import it from the utility.

---

### 2.4 check.ts Modifications

**File:** `/packages/cli/src/commands/check.ts`

#### Change 1: Import the new utility (add at top, around line 14)

**Before:**
```typescript
import type { GraphBackend } from '@grafema/types';
```

**After:**
```typescript
import type { GraphBackend } from '@grafema/types';
import { formatNodeInline } from '../utils/formatNode.js';
```

#### Change 2: Update violation display (lines 154-159)

**Before:**
```typescript
if (!result.passed && result.violations.length > 0) {
  console.log(`  Violations (${result.violationCount}):`);
  for (const v of result.violations.slice(0, 10)) {
    const location = v.file ? `${v.file}${v.line ? `:${v.line}` : ''}` : v.nodeId;
    console.log(`    - ${location}: ${v.name || v.type}`);
  }
```

**After:**
```typescript
if (!result.passed && result.violations.length > 0) {
  console.log(`  Violations (${result.violationCount}):`);
  for (const v of result.violations.slice(0, 10)) {
    // Prefer nodeId (semantic ID) for queryability, fallback to location
    const identifier = v.nodeId || (v.file ? `${v.file}${v.line ? `:${v.line}` : ''}` : '(unknown)');
    console.log(`    - ${identifier}`);
    if (v.name || v.type) {
      console.log(`      ${v.name || ''} (${v.type || 'unknown'})`);
    }
  }
```

---

## 3. Test Plan

### Test File Location
`/test/unit/FormatNode.test.js`

### Test Cases

```javascript
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatNodeDisplay, formatNodeInline, formatLocation } from '../../packages/cli/src/utils/formatNode.js';

describe('formatNode utility', () => {

  describe('formatNodeDisplay', () => {
    it('should format a function node with all fields', () => {
      const node = {
        id: 'src/auth/service.ts->AuthService->FUNCTION->authenticate',
        type: 'FUNCTION',
        name: 'authenticate',
        file: '/project/src/auth/service.ts',
        line: 42
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[FUNCTION] authenticate'));
      assert.ok(result.includes('ID: src/auth/service.ts->AuthService->FUNCTION->authenticate'));
      assert.ok(result.includes('Location: src/auth/service.ts:42'));
    });

    it('should handle node without line number', () => {
      const node = {
        id: 'src/index.ts->MODULE->main',
        type: 'MODULE',
        name: 'main',
        file: '/project/src/index.ts'
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[MODULE] main'));
      assert.ok(result.includes('Location: src/index.ts'));
      assert.ok(!result.includes(':undefined'));
    });

    it('should handle node without file', () => {
      const node = {
        id: 'unknown->FUNCTION->external',
        type: 'FUNCTION',
        name: 'external',
        file: ''
      };

      const result = formatNodeDisplay(node, { projectPath: '/project' });

      assert.ok(result.includes('[FUNCTION] external'));
      assert.ok(result.includes('ID: unknown->FUNCTION->external'));
      // Location line should be absent or empty
    });

    it('should respect showLocation option', () => {
      const node = {
        id: 'src/utils.ts->FUNCTION->helper',
        type: 'FUNCTION',
        name: 'helper',
        file: '/project/src/utils.ts',
        line: 10
      };

      const result = formatNodeDisplay(node, {
        projectPath: '/project',
        showLocation: false
      });

      assert.ok(!result.includes('Location:'));
    });

    it('should apply indent prefix', () => {
      const node = {
        id: 'src/app.ts->FUNCTION->run',
        type: 'FUNCTION',
        name: 'run',
        file: '/project/src/app.ts',
        line: 5
      };

      const result = formatNodeDisplay(node, {
        projectPath: '/project',
        indent: '  '
      });

      const lines = result.split('\n');
      assert.ok(lines[0].startsWith('  [FUNCTION]'));
      assert.ok(lines[1].startsWith('    ID:'));
    });
  });

  describe('formatNodeInline', () => {
    it('should return semantic ID only', () => {
      const node = {
        id: 'src/auth.ts->FUNCTION->login',
        type: 'FUNCTION',
        name: 'login',
        file: '/project/src/auth.ts',
        line: 20
      };

      const result = formatNodeInline(node);

      assert.equal(result, 'src/auth.ts->FUNCTION->login');
    });
  });

  describe('formatLocation', () => {
    it('should format relative path with line number', () => {
      const result = formatLocation('/project/src/file.ts', 42, '/project');
      assert.equal(result, 'src/file.ts:42');
    });

    it('should format relative path without line number', () => {
      const result = formatLocation('/project/src/file.ts', undefined, '/project');
      assert.equal(result, 'src/file.ts');
    });

    it('should return empty string for undefined file', () => {
      const result = formatLocation(undefined, 42, '/project');
      assert.equal(result, '');
    });

    it('should return empty string for empty file', () => {
      const result = formatLocation('', 42, '/project');
      assert.equal(result, '');
    });
  });
});
```

### Integration Test Cases

Additional integration tests should verify end-to-end output format. These can be added to existing command tests or created separately.

**Test file:** `/test/unit/CLISemanticIdOutput.test.js`

```javascript
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

describe('CLI Semantic ID Output', () => {
  const testDir = '/tmp/grafema-semantic-id-test';

  before(() => {
    // Create test project with sample code
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'package.json'), '{"name":"test"}');
    writeFileSync(join(testDir, 'index.js'), `
      function authenticate(user) {
        return validate(user);
      }
      function validate(data) {
        return data !== null;
      }
    `);

    // Run analysis
    execSync(`grafema analyze`, { cwd: testDir, stdio: 'pipe' });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('query command should show semantic ID in output', () => {
    const output = execSync(`grafema query "authenticate"`, {
      cwd: testDir,
      encoding: 'utf-8'
    });

    assert.ok(output.includes('ID:'), 'Output should include ID label');
    assert.ok(output.includes('->FUNCTION->authenticate'), 'Output should include semantic ID path');
  });

  it('query command callers should show semantic IDs', () => {
    const output = execSync(`grafema query "validate"`, {
      cwd: testDir,
      encoding: 'utf-8'
    });

    assert.ok(output.includes('Called by'), 'Output should show callers section');
    assert.ok(output.includes('->FUNCTION->'), 'Caller should be shown as semantic ID');
  });
});
```

---

## 4. Implementation Order

### Step 1: Create formatNode utility (Blocking)
1. Create `/packages/cli/src/utils/formatNode.ts`
2. Implement `formatNodeDisplay()`, `formatNodeInline()`, `formatLocation()`
3. Export all functions

**Dependencies:** None
**Estimated time:** 15 minutes

### Step 2: Write unit tests for formatNode (Blocking)
1. Create `/test/unit/FormatNode.test.js`
2. Run tests to verify utility works correctly

**Dependencies:** Step 1
**Estimated time:** 20 minutes

### Step 3: Update query.ts (Can be parallelized with 4-6)
1. Add import for formatNode utility
2. Update `displayNode()` function
3. Update caller display loop
4. Update callee display loop
5. Remove local `formatLocation()` function

**Dependencies:** Step 1, Step 2
**Estimated time:** 10 minutes

### Step 4: Update trace.ts (Can be parallelized with 3, 5-6)
1. Add import for formatNode utility
2. Update variable display
3. Update `displayTrace()` function
4. Remove local `formatLocation()` function

**Dependencies:** Step 1, Step 2
**Estimated time:** 10 minutes

### Step 5: Update impact.ts (Can be parallelized with 3-4, 6)
1. Add import for formatNode utility
2. Update `displayImpact()` target display
3. Update direct callers display
4. Remove local `formatLocation()` function

**Dependencies:** Step 1, Step 2
**Estimated time:** 10 minutes

### Step 6: Update check.ts (Can be parallelized with 3-5)
1. Add import for formatNode utility
2. Update violation display to prefer nodeId

**Dependencies:** Step 1, Step 2
**Estimated time:** 5 minutes

### Step 7: Write integration tests
1. Create `/test/unit/CLISemanticIdOutput.test.js`
2. Test actual CLI output format

**Dependencies:** Steps 3-6
**Estimated time:** 20 minutes

### Step 8: Manual verification
1. Run `grafema analyze` on test project
2. Run `grafema query "functionName"` and verify output
3. Run `grafema trace "varName"` and verify output
4. Run `grafema impact "functionName"` and verify output
5. Run `grafema check` and verify output

**Dependencies:** Steps 3-6
**Estimated time:** 10 minutes

---

## 5. Output Format Examples

### query command

**Before:**
```
Found: authenticate (FUNCTION)
Location: src/auth/service.ts:42

Called by (3+):
  ← validateToken (src/auth/service.ts:78)
  ← requireAuth (src/middleware/auth.ts:15)
  ← handleLogin (src/routes/login.ts:23)

Calls (2):
  → validate (src/auth/validator.ts:12)
  → hash (src/utils/crypto.ts:5)
```

**After:**
```
[FUNCTION] authenticate
  ID: src/auth/service.ts->AuthService->FUNCTION->authenticate
  Location: src/auth/service.ts:42

Called by (3+):
  <- src/auth/service.ts->AuthService->FUNCTION->validateToken
  <- src/middleware/auth.ts->FUNCTION->requireAuth
  <- src/routes/login.ts->FUNCTION->handleLogin

Calls (2):
  -> src/auth/validator.ts->FUNCTION->validate
  -> src/utils/crypto.ts->FUNCTION->hash
```

### trace command

**Before:**
```
Variable: userId
Location: src/auth/handlers.ts:15

Data sources (where value comes from):
  ← request.body.id (src/auth/handlers.ts:14)
  ← DEFAULT_USER (src/config.ts:5)
```

**After:**
```
[VARIABLE] userId
  ID: src/auth/handlers.ts->FUNCTION->authenticate->VARIABLE->userId
  Location: src/auth/handlers.ts:15

Data sources (where value comes from):
  <- request.body.id (EXPRESSION)
     src/auth/handlers.ts->FUNCTION->authenticate->EXPRESSION->request.body.id
  <- DEFAULT_USER (VARIABLE)
     src/config.ts->VARIABLE->DEFAULT_USER
```

### impact command

**Before:**
```
Target: authenticate (FUNCTION)
Location: src/auth/service.ts:42

Direct impact:
  5 direct callers
  12 transitive callers
  17 total affected

Direct callers:
  ← validateToken (src/auth/service.ts:78)
  ← requireAuth (src/middleware/auth.ts:15)
```

**After:**
```
[FUNCTION] authenticate
  ID: src/auth/service.ts->AuthService->FUNCTION->authenticate
  Location: src/auth/service.ts:42

Direct impact:
  5 direct callers
  12 transitive callers
  17 total affected

Direct callers:
  <- src/auth/service.ts->AuthService->FUNCTION->validateToken
  <- src/middleware/auth.ts->FUNCTION->requireAuth
```

### check command

**Before:**
```
✗ no-direct-db-access: No direct database access from controllers
  Violations (3):
    - src/controllers/user.ts:45: getUser
    - src/controllers/order.ts:23: createOrder
```

**After:**
```
✗ no-direct-db-access: No direct database access from controllers
  Violations (3):
    - src/controllers/user.ts->UserController->FUNCTION->getUser
      getUser (FUNCTION)
    - src/controllers/order.ts->OrderController->FUNCTION->createOrder
      createOrder (FUNCTION)
```

---

## 6. ASCII vs Unicode Note

The plan uses ASCII arrows (`<-`, `->`) instead of Unicode arrows (`←`, `→`) for better cross-platform compatibility and copy-paste friendliness. This is intentional per Don's principle: "don't abbreviate semantic IDs - they're designed to be copy-paste friendly."

---

## 7. Summary

| File | Changes | LOC Changed (est.) |
|------|---------|-------------------|
| `packages/cli/src/utils/formatNode.ts` | New file | +50 |
| `packages/cli/src/commands/query.ts` | 5 changes | ~30 |
| `packages/cli/src/commands/trace.ts` | 4 changes | ~25 |
| `packages/cli/src/commands/impact.ts` | 4 changes | ~20 |
| `packages/cli/src/commands/check.ts` | 2 changes | ~10 |
| `test/unit/FormatNode.test.js` | New file | +80 |
| `test/unit/CLISemanticIdOutput.test.js` | New file | +50 |

**Total estimated lines changed:** ~265 lines
**Total estimated time:** 1.5-2 hours

This plan provides everything needed for implementation. Each step is atomic and testable. A junior developer should be able to follow this plan without ambiguity.

---

*"The details are not the details. They make the design." - Charles Eames*
