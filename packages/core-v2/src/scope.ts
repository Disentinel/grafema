/**
 * Scope tree: build during Walk, resolve during File stage.
 *
 * O(depth) lookup — scope depth in real JS is 3-7 levels.
 *
 * ScopeRegistry tracks all created scopes by ID for Stage 2 resolution.
 */
import type { ScopeNode, ScopeKind, DeclKind, Declaration, ScopeLookupResult } from './types.js';

// ─── Scope Registry ──────────────────────────────────────────────────

/**
 * Tracks all scopes created during walk for O(1) lookup by ID.
 * Stage 2 uses this to find the scope from which a deferred ref was made.
 */
export class ScopeRegistry {
  private scopes = new Map<string, ScopeNode>();

  register(scope: ScopeNode): void {
    this.scopes.set(scope.id, scope);
  }

  get(id: string): ScopeNode | undefined {
    return this.scopes.get(id);
  }

  get size(): number {
    return this.scopes.size;
  }
}

// ─── Scope Creation ──────────────────────────────────────────────────

export function createModuleScope(moduleId: string, strict: boolean, registry: ScopeRegistry): ScopeNode {
  const scope: ScopeNode = {
    id: moduleId,
    kind: 'module',
    strict,
    parent: null,
    children: [],
    declarations: new Map(),
    hoistTarget: null!,
  };
  scope.hoistTarget = scope;
  registry.register(scope);
  return scope;
}

export function createChildScope(
  parent: ScopeNode,
  kind: ScopeKind,
  id: string,
  registry: ScopeRegistry,
): ScopeNode {
  const isHoistTarget = kind === 'function' || kind === 'module';
  const scope: ScopeNode = {
    id,
    kind,
    strict: parent.strict || kind === 'class',
    parent,
    children: [],
    declarations: new Map(),
    hoistTarget: isHoistTarget ? null! : parent.hoistTarget,
  };
  if (isHoistTarget) scope.hoistTarget = scope;
  parent.children.push(scope);
  registry.register(scope);
  return scope;
}

// ─── Declaration ─────────────────────────────────────────────────────

/**
 * Declare a name in scope. Returns the shadowed node ID if this
 * declaration shadows a same-named declaration in an ancestor scope.
 */
export function declare(scope: ScopeNode, name: string, kind: DeclKind, nodeId: string): string | null {
  // Check ancestor scopes for shadowing before declaring
  let shadowedNodeId: string | null = null;
  let ancestor = scope.parent;
  while (ancestor) {
    const existing = ancestor.declarations.get(name);
    if (existing) {
      shadowedNodeId = existing.nodeId;
      break;
    }
    ancestor = ancestor.parent;
  }

  const decl: Declaration = { nodeId, kind, name };
  if (kind === 'var') {
    scope.hoistTarget.declarations.set(name, decl);
  } else {
    scope.declarations.set(name, decl);
  }
  return shadowedNodeId;
}

// ─── Scope Lookup ────────────────────────────────────────────────────

export function scopeLookup(name: string, scope: ScopeNode): ScopeLookupResult {
  let current: ScopeNode | null = scope;
  let crossedFunction = false;
  while (current) {
    if (current.kind === 'with') {
      const outer = current.parent ? scopeLookup(name, current.parent) : null;
      return {
        kind: 'ambiguous',
        withObjectId: current.withObjectId!,
        outerResult: outer,
      };
    }

    const decl = current.declarations.get(name);
    if (decl) {
      return { kind: 'found', nodeId: decl.nodeId, declaration: decl, crossedFunction };
    }

    // Moving to parent — if current is a function scope, we're crossing a function boundary
    if (current.kind === 'function') {
      crossedFunction = true;
    }
    current = current.parent;
  }
  return { kind: 'not_found' };
}
