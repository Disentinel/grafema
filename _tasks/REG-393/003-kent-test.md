# Kent Beck — Test Report for REG-393

**Date:** 2025-02-09
**Task:** Write test to reproduce directory index resolution bug
**Result:** Test passes — bug already fixed

## What I Did

1. Read existing test patterns in `test/unit/plugins/indexing/JSModuleIndexer.test.ts`
2. Understood the test structure using `MockGraphBackend` and helper functions
3. Studied the indexer source code and `moduleResolution.ts` utility
4. Wrote a new test case that reproduces the axios scenario:
   ```
   lib/
     index.js         → require('./defaults')
     defaults/
       index.js       → (some content)
   ```

## Test Code

Added to `JSModuleIndexer.test.ts` (new describe block before "Include/Exclude Pattern Filtering"):

```typescript
describe('Directory Index Resolution (REG-393)', () => {
  it('should resolve require("./defaults") to defaults/index.js', async () => {
    // Setup: Create directory structure like axios
    mkdirSync(join(tempDir, 'lib'), { recursive: true });
    mkdirSync(join(tempDir, 'lib', 'defaults'), { recursive: true });

    writeFileSync(join(tempDir, 'lib', 'index.js'), `
      const defaults = require('./defaults');
      module.exports = { defaults };
    `);
    writeFileSync(join(tempDir, 'lib', 'defaults', 'index.js'), `
      module.exports = { key: 'value' };
    `);

    const graph = new MockGraphBackend();
    const indexer = new JSModuleIndexer();
    const result = await indexer.execute(createContext(tempDir, 'lib/index.js', graph));

    // Verify: Plugin succeeded
    assert.strictEqual(result.success, true, 'Plugin should succeed');

    // Get all nodes
    const nodes = await graph.getAllNodes();
    const nodeIds = nodes.map((n: any) => n.id);

    // Verify: defaults/index.js has a MODULE node
    const hasDefaultsIndex = nodeIds.some((id: string) =>
      id.includes('lib/defaults/index.js') || id.includes('lib\\defaults\\index.js')
    );
    assert.ok(hasDefaultsIndex, 'defaults/index.js should have a MODULE node');

    // Verify: lib/index.js DEPENDS_ON defaults/index.js
    const hasDependency = graph.edges.some((edge: any) =>
      (edge.src.includes('lib/index.js') || edge.src.includes('lib\\index.js')) &&
      (edge.dst.includes('lib/defaults/index.js') || edge.dst.includes('lib\\defaults\\index.js')) &&
      edge.type === 'DEPENDS_ON'
    );
    assert.ok(hasDependency, 'lib/index.js should DEPEND_ON defaults/index.js');
  });
});
```

## Test Result

**Status:** ✅ PASSED

The test passes on the first run. Looking at the debug output:

```
[DEBUG] Resolved dependency {
  "from": "/var/folders/.../lib/defaults",
  "to": "/lib/defaults/index.js"
}
```

The resolution correctly found `defaults/index.js` when given `./defaults`.

## Why It Works

Inspecting the code flow:

1. **`JSModuleIndexer.resolveModulePath()`** (line 245):
   ```typescript
   private resolveModulePath(path: string): string {
     return resolveModulePathUtil(path, { useFilesystem: true }) ?? path;
   }
   ```

2. **`moduleResolution.ts`** already implements directory index resolution (lines 180-186):
   ```typescript
   // Try index files in directory
   for (const indexFile of indexFiles) {
     const testPath = join(normalizedPath, indexFile);
     if (pathExists(testPath, useFilesystem, fileIndex)) {
       return testPath;
     }
   }
   ```

3. **DEFAULT_INDEX_FILES** constant (lines 26-33):
   ```typescript
   export const DEFAULT_INDEX_FILES = [
     'index.js',
     'index.ts',
     // ... other variants
   ];
   ```

## Conclusion

The bug described in REG-393 does **not exist** in the current codebase. The resolution logic already handles directory index resolution correctly.

**This was likely fixed by REG-320** (shared `moduleResolution.ts` utility), which centralized and improved module resolution logic across all plugins.

## Recommendation

1. **Keep the test** — it's valuable regression protection
2. **Close REG-393 as "Already Fixed"** — the feature works correctly
3. **Credit REG-320** — that task likely resolved this issue as a side effect

The test is minimal, focused, and follows existing patterns. It clearly communicates intent: "directory imports should resolve to index.js files."
