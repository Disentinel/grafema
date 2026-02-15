# Don Exploration: Type Extraction & Discovery Issues (REG-445)

**Date:** 2026-02-15
**Task:** REG-445 — TypeScript type symbols not indexed
**Status:** Root cause identified

## Executive Summary

**Original hypothesis:** Two problems — discovery failure + missing type extraction.
**Actual state (verified):** Discovery works, type extraction works, BUT MODULE nodes aren't created.

**Root cause:** JSModuleIndexer doesn't create MODULE nodes for packages/types, causing all extracted nodes (INTERFACE, TYPE, FUNCTION) to be orphaned and disconnected.

**Evidence:**
- ✅ 253 nodes exist from packages/types (all disconnected)
- ✅ INTERFACE and TYPE nodes ARE created correctly
- ❌ ZERO MODULE nodes in entire graph
- Broken import errors (false positives) suggest import resolution issues

**Next investigation:** Why does JSModuleIndexer skip packages/types? Check entrypoint path resolution and import resolution logic.

---

## Problem Summary (Initial Hypothesis — Partially Incorrect)

Two suspected issues:

1. **Discovery:** `packages/types` package is listed in config.yaml but analysis produces 0 source files → **FALSE** (it IS analyzed)
2. **Type Extraction:** TypeScript interfaces and type aliases ARE collected but NOT converted to graph nodes → **FALSE** (they ARE converted)

## Problem 1: Discovery — Why packages/types is Missed

### How Discovery Works

Discovery happens in `packages/core/src/Orchestrator.ts:discover()`:

**Path 1: Config-provided services** (REG-174)
- If `configServices` is provided → skip discovery plugins, use config directly
- Creates SERVICE nodes, resolves entrypoints via `resolveSourceEntrypoint()`
- Lines 846-914 in Orchestrator.ts

**Path 2: Discovery plugins**
- If no config services → runs DISCOVERY phase plugins
- Default: `WorkspaceDiscovery` (pnpm-workspace aware)
- Fallback: `SimpleProjectDiscovery` (single package.json)

### Entry Point Resolution Logic

`packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts`:

```typescript
export function resolveSourceEntrypoint(
  projectPath: string,
  packageJson: PackageJsonForResolution
): string | null {
  // Step 1: Check for TypeScript project indicator
  const tsconfigPath = join(projectPath, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return null; // Not a TypeScript project
  }

  // Step 2: Check package.json "source" field
  if (packageJson.source) { /* ... */ }

  // Step 3: Try standard TypeScript source candidates
  const TS_SOURCE_CANDIDATES = [
    'src/index.ts',
    'src/index.tsx',
    'src/index.mts',
    'src/main.ts',
    // ...
  ];
  for (const candidate of TS_SOURCE_CANDIDATES) {
    if (existsSync(join(projectPath, candidate))) {
      return candidate;
    }
  }

  // Step 4: Not found - caller should fallback to main
  return null;
}
```

### Why packages/types Fails

**Config entry:**
```yaml
services:
  - name: "types"
    path: "packages/types"
    entryPoint: "src/index.ts"  # <-- This is CORRECT
```

**package.json:**
```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts"
}
```

**Resolution flow:**
1. `resolveSourceEntrypoint("packages/types", packageJson)` is called
2. ✅ tsconfig.json exists at `packages/types/tsconfig.json`
3. ❌ No "source" field in package.json
4. ✅ `packages/types/src/index.ts` exists in candidates list
5. ✅ Should return `"src/index.ts"`

**BUT:** Config already specifies `entryPoint: "src/index.ts"`, so this should work!

**Hypothesis:** The issue is NOT in resolveSourceEntrypoint. Need to check:
- Does `Orchestrator.discover()` actually use config services for this project?
- Are there logs showing "Using config-provided services"?
- Is the entrypoint path being resolved correctly (relative vs absolute)?

**Key files to check:**
- `/Users/vadim/grafema-worker-15/.grafema/config.yaml` (already read — services IS defined)
- Orchestrator lines 858-907: service entrypoint resolution
- Line 898: `metadata.entrypoint: join(servicePath, entrypoint)`

**Likely root cause:** Entrypoint resolution constructs absolute path, but JSModuleIndexer might be receiving wrong path or path doesn't exist. Need to verify:
```bash
ls -la /Users/vadim/grafema-worker-15/packages/types/src/index.ts
```

## Problem 2: Type Extraction — Interfaces & Type Aliases Not Indexed

### Current State: Data is Collected

**TypeScriptVisitor exists** (`packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`):

✅ Handles:
- `TSInterfaceDeclaration` → `InterfaceDeclarationInfo`
- `TSTypeAliasDeclaration` → `TypeAliasInfo`
- `TSEnumDeclaration` → `EnumDeclarationInfo`

Data is pushed to collections:
```typescript
(interfaces as InterfaceDeclarationInfo[]).push({ ... });
(typeAliases as TypeAliasInfo[]).push({ ... });
(enums as EnumDeclarationInfo[]).push({ ... });
```

### GraphBuilder DOES Process Them

**TypeSystemBuilder exists** (`packages/core/src/plugins/analysis/ast/builders/TypeSystemBuilder.ts`):

```typescript
export class TypeSystemBuilder implements DomainBuilder {
  buffer(module: ModuleNode, data: ASTCollections): void {
    const {
      interfaces = [],
      typeAliases = [],
      enums = [],
      // ...
    } = data;

    this.bufferInterfaceNodes(module, interfaces);  // Line 62
    this.bufferTypeAliasNodes(module, typeAliases); // Line 64
    this.bufferEnumNodes(module, enums);           // Line 65
  }
}
```

**GraphBuilder.build() calls TypeSystemBuilder:**
```typescript
// Line 273 in GraphBuilder.ts
this._typeSystemBuilder.buffer(module, data);
```

### Node Types EXIST in Schema

`packages/types/src/nodes.ts` defines:
- ❌ No `INTERFACE` in `NODE_TYPE` constants
- ❌ No `TYPE_ALIAS` in `NODE_TYPE` constants
- ❌ No `ENUM` in `NODE_TYPE` constants

**BUT:** They're created as string types by factory methods.

### Factory Methods EXIST

**InterfaceNode.create()** (`packages/core/src/core/nodes/InterfaceNode.ts`):
```typescript
export interface InterfaceNodeRecord extends BaseNodeRecord {
  type: 'INTERFACE';
  extends?: string[];
  properties?: InterfacePropertyInfo[];
  isExternal?: boolean;
}

export class InterfaceNode {
  static create(
    name: string,
    file: string,
    line: number,
    column: number,
    metadata?: { extends?: string[]; properties?: InterfacePropertyInfo[]; isExternal?: boolean }
  ): InterfaceNodeRecord {
    const id = `${file}:INTERFACE:${name}:${line}`;
    return {
      id,
      type: 'INTERFACE',
      name,
      file,
      line,
      column,
      ...metadata
    };
  }
}
```

**NodeFactory.createType()** and **NodeFactory.createInterface()** exist.

### Verification: Are Nodes Actually Created?

**TypeSystemBuilder.bufferInterfaceNodes()** (lines 169-229):
```typescript
for (const iface of interfaces) {
  const interfaceNode = InterfaceNode.create(
    iface.name,
    iface.file,
    iface.line,
    iface.column || 0,
    { extends: iface.extends, properties: iface.properties }
  );
  interfaceNodes.set(iface.name, interfaceNode);
  this.ctx.bufferNode(interfaceNode as unknown as GraphNode);  // <-- BUFFERED

  // MODULE -> CONTAINS -> INTERFACE
  this.ctx.bufferEdge({
    type: 'CONTAINS',
    src: module.id,
    dst: interfaceNode.id
  });
}
```

✅ Nodes ARE created and buffered
✅ CONTAINS edges are created
✅ EXTENDS edges are created (lines 195-227)

**TypeSystemBuilder.bufferTypeAliasNodes()** (lines 316-349):
```typescript
for (const typeAlias of typeAliases) {
  const typeNode = NodeFactory.createType(
    typeAlias.name,
    typeAlias.file,
    typeAlias.line,
    typeAlias.column || 0,
    { aliasOf: typeAlias.aliasOf, /* ... */ }
  );
  this.ctx.bufferNode(typeNode as unknown as GraphNode);  // <-- BUFFERED

  // MODULE -> CONTAINS -> TYPE
  this.ctx.bufferEdge({
    type: 'CONTAINS',
    src: module.id,
    dst: typeNode.id
  });
}
```

✅ Type alias nodes ARE created and buffered
✅ CONTAINS edges are created

### Conclusion: Implementation is COMPLETE

**The code to extract and index TypeScript type symbols already exists and should work.**

If types aren't showing up in the graph, the root cause is likely:

1. **packages/types is not being analyzed** (Problem 1 — discovery issue)
2. **OR** JSASTAnalyzer is not running on .ts files in packages/types
3. **OR** TypeScriptVisitor is not being invoked (check visitor registration)

## Key Files That Will Need Changes

**If the issue is discovery:**
- None — config.yaml already correct
- Debug: add logging to Orchestrator.discover() to see which path is taken
- Verify: does JSModuleIndexer receive packages/types/src/index.ts?

**If the issue is visitor registration:**
- `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` — check visitor instantiation
- Verify: is TypeScriptVisitor included in the visitor list?

**If node types need to be added to schema:**
- `packages/types/src/nodes.ts` — add INTERFACE, TYPE_ALIAS, ENUM to NODE_TYPE
- But this is NOT required — string types work fine

## Patterns to Follow

**Node Creation:**
- Use factory methods: `InterfaceNode.create()`, `NodeFactory.createType()`
- ID format: `{file}:INTERFACE:{name}:{line}` or `{file}:TYPE:{name}:{line}`
- Always create MODULE → CONTAINS → TYPE/INTERFACE edges

**External References:**
- For cross-file types, create external reference nodes with `isExternal: true`
- Same pattern as bufferInterfaceNodes() lines 211-225

**Type Extraction:**
- TypeScriptVisitor.typeNodeToString() handles all TS type syntax
- Supports: primitives, unions, intersections, mapped types, conditional types, etc.

## Next Steps

1. **Verify discovery:** Run `grafema analyze` with debug logging to see if packages/types is discovered
2. **Check JSModuleIndexer output:** Does it find any .ts files in packages/types/src/?
3. **Check visitor registration:** Is TypeScriptVisitor instantiated in JSASTAnalyzer?
4. **If all above passes:** The implementation should work — check graph for INTERFACE/TYPE nodes

## Existing Patterns in Codebase

**Similar feature:** EnumDeclarationInfo → EnumNode
- Visitor: TypeScriptVisitor handles TSEnumDeclaration (lines 431-477)
- Builder: TypeSystemBuilder.bufferEnumNodes() (lines 355-379)
- Factory: EnumNode.create() in `packages/core/src/core/nodes/EnumNode.ts`
- ✅ Same pattern, already implemented

**Similar feature:** ClassDeclarationInfo → CLASS node
- Visitor: ClassVisitor handles ClassDeclaration
- Builder: TypeSystemBuilder.bufferClassDeclarationNodes() (lines 71-132)
- ✅ Same pattern, already implemented

**External reference pattern:** Used for:
- External interfaces (bufferInterfaceNodes lines 211-225)
- Type parameter constraints (bufferTypeParameterNodes lines 283-307)
- Class implements (bufferImplementsEdges lines 426-441)

## Summary — ROOT CAUSE IDENTIFIED

**Actual State (verified by querying graph):**

1. ✅ **packages/types IS analyzed** — nodes exist for all .ts files
2. ✅ **INTERFACE and TYPE nodes ARE created** — "PluginPhase" (TYPE), "WireNode" (INTERFACE), etc.
3. ❌ **NO MODULE nodes exist** — all nodes are disconnected from main graph

**Diagnostics evidence:**
```
Found 253 unreachable nodes (95.1% of total)
Node "PluginPhase" (type: TYPE) is not connected to the main graph
Node "WireNode" (type: INTERFACE) is not connected to the main graph
```

**Root Cause:**
The problem is NOT in discovery or type extraction. The problem is in **JSModuleIndexer** — it's not creating MODULE nodes for packages/types, which means all other nodes (INTERFACE, TYPE, FUNCTION, etc.) are orphaned.

**Why MODULE nodes are missing:**
JSModuleIndexer likely has import resolution issues specific to packages/types. Looking at broken import errors:
```
ERR_BROKEN_IMPORT: Import "NodeRecord" from "./nodes.js" - export doesn't exist
ERR_BROKEN_IMPORT: Import "EdgeRecord" from "./edges.js" - export doesn't exist
```

These are FALSE POSITIVES (the exports DO exist), but they indicate JSModuleIndexer's import resolution is failing for packages/types.

**Hypothesis:** JSModuleIndexer doesn't create MODULE nodes when it can't resolve imports, OR the entrypoint path is wrong so no traversal happens.

**Problem 1 (Discovery):** ✅ WORKS — types service IS discovered and analyzed
**Problem 2 (Type Extraction):** ✅ WORKS — INTERFACE/TYPE nodes ARE created

**Real Problem:** **JSModuleIndexer doesn't create MODULE nodes for packages/types**

**Verification Steps:**
```bash
# ✅ 1. Check if dist exists
ls -la /Users/vadim/grafema-worker-15/packages/types/dist/
# Result: exists, built at 2026-02-15 12:46

# ✅ 2. Check if src/index.ts exists
ls -la /Users/vadim/grafema-worker-15/packages/types/src/index.ts
# Result: exists, -rw-r--r--@ 1 vadim  staff  461

# ✅ 3. Query graph for packages/types nodes
grafema query "SELECT type, COUNT(*) FROM nodes WHERE file LIKE '%types%' GROUP BY type"
# Result: 253 nodes exist (INTERFACE, TYPE, FUNCTION, PARAMETER, etc.)

# ❌ 4. Query graph for MODULE nodes
grafema query "SELECT * FROM nodes WHERE type = 'MODULE'"
# Result: ZERO modules

# ✅ 5. Check diagnostics
tail -100 .grafema/diagnostics.log
# Result: All packages/types nodes are disconnected, broken import errors
```

**Next Steps:**

1. **Find JSModuleIndexer** and understand why it's not creating MODULE nodes
2. **Check import resolution** in JSModuleIndexer — why are NodeRecord/EdgeRecord imports "broken"?
3. **Verify entrypoint path** used by JSModuleIndexer — is it receiving the correct path?
4. **Check if JSModuleIndexer has special handling** for .ts vs .js files
