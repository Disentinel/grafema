export { walkFile, parseFile } from './walk.js';
export type { WalkOptions } from './walk.js';
export { resolveFileRefs, resolveProject, ProjectIndex } from './resolve.js';
export type { ResolveResult } from './resolve.js';
export type { BuiltinRegistry } from '@grafema/lang-defs';
export { jsRegistry } from './registry.js';
export { ScopeRegistry, scopeLookup, createModuleScope, createChildScope, declare } from './scope.js';
export type {
  GraphNode,
  GraphEdge,
  VisitResult,
  DeferredRef,
  DeferredKind,
  ScopeNode,
  ScopeKind,
  DeclKind,
  Declaration,
  ScopeLookupResult,
  WalkContext,
  VisitorFn,
  VisitorRegistry,
  FileResult,
  DomainPlugin,
  DomainPluginResult,
} from './types.js';
export { EMPTY_RESULT } from './types.js';
export { EDGE_MAP } from './edge-map.js';
export type { EdgeMapping } from './edge-map.js';
