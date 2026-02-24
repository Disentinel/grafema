# Edge Type Classification

You are classifying a single edge type's **requirement profile** for a graph-based code analyzer.

## Grafema's 3-Phase Model

Grafema builds a semantic graph of code in three phases:

### Phase 1: Walk (AST traversal)
- Single pass over the AST of one file
- Can see: current AST node, parent nodes, scope stack
- Creates nodes and edges where both endpoints come from the local AST subtree
- **Examples:** CONTAINS (parent→child), DECLARES (scope→variable), HAS_CONDITION (if→expr)

### Phase 2: Post-File (after one file is fully walked)
- All nodes from the current file exist
- Can see: all nodes created in the file, scope relationships
- Creates edges that connect sibling nodes (nodes in the same file but different AST subtrees)
- **Examples:** CAPTURES (closure→outer variable), ASSIGNED_FROM (variable→value across statements)

### Phase 3: Post-Project (after all files are walked)
- All nodes from all files exist
- Can see: the entire graph
- Creates edges that require cross-file resolution or type inference
- **Examples:** IMPORTS_FROM (import→module), CALLS (call site→function definition in another file), IMPLEMENTS (class→interface)

## Classification Rules

Given an edge type with its usage examples, classify its **needs**:

| Need | Meaning |
|------|---------|
| `astLocal` | Both src and dst nodes come from the same AST subtree (parent-child or siblings within one statement) |
| `scopeStack` | Requires knowing the current scope chain (function/block/class nesting) |
| `siblingNodes` | Requires nodes already created from other statements in the same file |
| `crossFile` | Requires nodes from other files (imports, cross-module references) |
| `typeInfo` | Requires type inference or resolution beyond simple AST inspection |

## Phase Derivation

The phase is derived deterministically from needs:
- `crossFile=true` OR `typeInfo=true` → **post-project**
- `siblingNodes=true` (and not crossFile/typeInfo) → **post-file**
- Otherwise → **walk**

## Known Anchors (use these as calibration)

- CONTAINS → walk (parent→child in AST)
- DECLARES → walk (scope→declaration, both in local AST)
- HAS_CONDITION → walk (control flow node→condition expression)
- ASSIGNED_FROM → post-file (variable←value, may be across statements)
- CAPTURES → post-file (closure→outer variable, same file different scope)
- IMPORTS_FROM → post-project (import→external module)
- CALLS (cross-file) → post-project (call site→function in another module)
- IMPLEMENTS → post-project (class→interface, may be in different file)

## Output Format

Return a JSON object:

```json
{
  "needs": {
    "astLocal": true,
    "scopeStack": false,
    "siblingNodes": false,
    "crossFile": false,
    "typeInfo": false
  },
  "rationale": "Brief explanation of why this edge type has these requirements"
}
```

Be precise. If an edge type can SOMETIMES be resolved locally but SOMETIMES needs cross-file context, classify based on the general case (what's needed to handle ALL instances correctly).
