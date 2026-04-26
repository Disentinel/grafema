# REG-485 Plan Addendum: Full Scope (including interface inheritance)

**Date:** 2026-02-17
**Status:** Approved by user — NO deferral, implement everything

## Change from v2 Plan

The ONLY change: `buildInterfaceMethodIndex()` must follow EXTENDS edges on INTERFACE nodes to collect inherited methods.

## Algorithm: buildInterfaceMethodIndex (with inheritance)

```typescript
async function buildInterfaceMethodIndex(
  graph: PluginContext['graph'],
  logger: Logger
): Promise<Map<string, Set<string>>> {
  const methodToInterfaces = new Map<string, Set<string>>();

  // Step 1: Collect all interface properties (direct only)
  const interfaceProperties = new Map<string, Set<string>>(); // interfaceName -> method names
  const interfaceExtends = new Map<string, string[]>(); // interfaceName -> parent interface names

  for await (const ifaceNode of graph.queryNodes({ nodeType: 'INTERFACE' })) {
    const ifaceName = ifaceNode.name as string;
    if (!ifaceName) continue;

    const methods = new Set<string>();

    // Extract method names from properties metadata
    const properties = ifaceNode.properties as Array<{name: string}> | undefined;
    if (properties) {
      for (const prop of properties) {
        if (prop.name) methods.add(prop.name);
      }
    }
    interfaceProperties.set(ifaceName, methods);

    // Track EXTENDS for inheritance resolution
    const extendsEdges = await graph.getOutgoingEdges(ifaceNode.id, ['EXTENDS']);
    const parentNames: string[] = [];
    for (const edge of extendsEdges) {
      const parentNode = await graph.getNode(edge.dst);
      if (parentNode?.name) parentNames.push(parentNode.name as string);
    }
    if (parentNames.length > 0) {
      interfaceExtends.set(ifaceName, parentNames);
    }
  }

  // Step 2: Flatten inherited methods (walk EXTENDS chain)
  function getMethodsWithInherited(ifaceName: string, visited: Set<string> = new Set()): Set<string> {
    if (visited.has(ifaceName)) return new Set(); // cycle protection
    visited.add(ifaceName);

    const ownMethods = interfaceProperties.get(ifaceName) || new Set();
    const allMethods = new Set(ownMethods);

    const parents = interfaceExtends.get(ifaceName);
    if (parents) {
      for (const parent of parents) {
        const parentMethods = getMethodsWithInherited(parent, visited);
        for (const m of parentMethods) allMethods.add(m);
      }
    }
    return allMethods;
  }

  // Step 3: Build final index: method name -> interfaces
  for (const ifaceName of interfaceProperties.keys()) {
    const allMethods = getMethodsWithInherited(ifaceName);
    for (const methodName of allMethods) {
      let interfaces = methodToInterfaces.get(methodName);
      if (!interfaces) {
        interfaces = new Set();
        methodToInterfaces.set(methodName, interfaces);
      }
      interfaces.add(ifaceName);
    }
  }

  return methodToInterfaces;
}
```

## Key: Why this handles inheritance

For:
```typescript
interface Base { save(): void }
interface Child extends Base { load(): void }
class Impl implements Child { save() {} load() {} }
```

Step 1: `interfaceProperties = { Base: {"save"}, Child: {"load"} }`, `interfaceExtends = { Child: ["Base"] }`
Step 2: `getMethodsWithInherited("Child")` = {"load", "save"} (inherits from Base)
Step 3: `methodToInterfaces = { "save": Set(["Base", "Child"]), "load": Set(["Child"]) }`

Resolution for `c.save()`:
- `methodToInterfaces.get("save")` → Set(["Base", "Child"])
- `interfaceImpls.get("Child")` → Set(["Impl"])
- `classMethodIndex.get("Impl").methods.get("save")` → ✅ METHOD node

## Scope Summary

1. `MethodCallIndexers.ts` — add `buildInterfaceMethodIndex()` (with EXTENDS inheritance) + `buildInterfaceImplementationIndex()`
2. `MethodCallResolution.ts` — add `resolveViaInterfaceCHA()` + wire into `resolveMethodCall()`
3. `MethodCallResolver.ts` — pass new indexes
4. Tests — full coverage including inheritance case
