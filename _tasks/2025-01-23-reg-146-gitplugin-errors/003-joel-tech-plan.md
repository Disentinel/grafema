# Joel Spolsky - Technical Implementation Plan

## Overview

Convert 6 silent catch blocks in GitPlugin to throw FileAccessError, then update caller.

## Detailed Steps

### Step 1: Add Import

**File:** `packages/core/src/plugins/vcs/GitPlugin.ts`

Add at top:
```typescript
import { FileAccessError } from '../../errors/GrafemaError.js';
```

### Step 2: Fix getChangedFiles() - Inner Catch (Lines 103-105)

**Current:**
```typescript
} catch {
  // Игнорируем ошибки чтения файла
}
```

**New:**
```typescript
} catch (error) {
  // Non-critical: file may be binary or unreadable, continue with null hash
  // We still report the file as changed, just without hash
}
```

*Note: This inner catch is for content hashing, not git operation. The file was already found by git status. Keep as warning-level logging but don't throw - the file is still reported as changed.*

### Step 3: Fix getChangedFiles() - Outer Catch (Lines 115-118)

**Current:**
```typescript
} catch (error) {
  console.error('[GitPlugin] Failed to get changed files:', (error as Error).message);
  return [];
}
```

**New:**
```typescript
} catch (error) {
  throw new FileAccessError(
    `Failed to get changed files: ${(error as Error).message}`,
    'ERR_GIT_ACCESS_DENIED',
    { plugin: 'GitPlugin' },
    'Check that git is installed and this is a valid git repository'
  );
}
```

### Step 4: Fix getFileDiff() (Lines 154-157)

**Current:**
```typescript
} catch (error) {
  console.error(`[GitPlugin] Failed to get diff for ${filePath}:`, (error as Error).message);
  return { path: filePath, hunks: [] };
}
```

**New:**
```typescript
} catch (error) {
  throw new FileAccessError(
    `Failed to get diff for ${filePath}: ${(error as Error).message}`,
    'ERR_GIT_ACCESS_DENIED',
    { plugin: 'GitPlugin', filePath },
    'Ensure the file is tracked by git and the working directory is accessible'
  );
}
```

### Step 5: Fix getCurrentBranch() (Lines 167-169)

**Current:**
```typescript
} catch {
  return 'unknown';
}
```

**New:**
```typescript
} catch (error) {
  throw new FileAccessError(
    `Failed to get current branch: ${(error as Error).message}`,
    'ERR_GIT_ACCESS_DENIED',
    { plugin: 'GitPlugin' },
    'Ensure this is a valid git repository with at least one commit'
  );
}
```

### Step 6: Fix getLastCommitHash() (Lines 179-181)

**Current:**
```typescript
} catch {
  return null;
}
```

**New:**
```typescript
} catch (error) {
  throw new FileAccessError(
    `Failed to get last commit hash: ${(error as Error).message}`,
    'ERR_GIT_NOT_FOUND',
    { plugin: 'GitPlugin' },
    'Ensure this is a valid git repository with at least one commit'
  );
}
```

### Step 7: Fix getAllTrackedFiles() (Lines 311-314)

**Current:**
```typescript
} catch (error) {
  console.error('[GitPlugin] Failed to get tracked files:', (error as Error).message);
  return [];
}
```

**New:**
```typescript
} catch (error) {
  throw new FileAccessError(
    `Failed to get tracked files: ${(error as Error).message}`,
    'ERR_GIT_ACCESS_DENIED',
    { plugin: 'GitPlugin' },
    'Check that git is installed and this is a valid git repository'
  );
}
```

### Step 8: Fix getLastCommitInfo() (Lines 332-334)

**Current:**
```typescript
} catch {
  return null;
}
```

**New:**
```typescript
} catch (error) {
  throw new FileAccessError(
    `Failed to get last commit info: ${(error as Error).message}`,
    'ERR_GIT_NOT_FOUND',
    { plugin: 'GitPlugin' },
    'Ensure this is a valid git repository with at least one commit'
  );
}
```

### Step 9: Update IncrementalAnalysisPlugin

**File:** `packages/core/src/plugins/analysis/IncrementalAnalysisPlugin.ts`

The execute() method already has try/catch. The thrown FileAccessError will propagate to it and be handled by createErrorResult().

For better error handling, we could add specific catch for FileAccessError, but the current generic handler is acceptable for this scope.

## Test Cases

1. **getChangedFiles throws on git failure**
   - Mock _exec to throw
   - Verify FileAccessError with ERR_GIT_ACCESS_DENIED

2. **getFileDiff throws on git failure**
   - Same pattern

3. **getCurrentBranch throws instead of returning 'unknown'**

4. **getLastCommitHash throws instead of returning null**

5. **getAllTrackedFiles throws on git failure**

6. **getLastCommitInfo throws instead of returning null**

7. **isAvailable still returns false on failure** (no change)

8. **isTracked still returns false on failure** (no change)

9. **getCommittedContent still returns null for new files** (no change)

## Files to Modify

1. `packages/core/src/plugins/vcs/GitPlugin.ts` - Main changes
2. `packages/core/test/unit/plugins/vcs/GitPlugin.test.ts` - New test file

## Estimated Scope

- ~30 lines changed in GitPlugin
- ~100 lines in new test file
