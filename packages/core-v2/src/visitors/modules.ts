/**
 * Visitors for module-related AST nodes.
 *
 * ImportDeclaration, ExportNamedDeclaration, ExportDefaultDeclaration,
 * ExportAllDeclaration
 */
import type {
  ClassDeclaration,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  FunctionDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  Node,
  StringLiteral,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSModuleDeclaration,
  TSTypeAliasDeclaration,
  VariableDeclaration,
} from '@babel/types';
import type { VisitResult, WalkContext } from '../types.js';
import { EMPTY_RESULT } from '../types.js';

// ─── ImportDeclaration ───────────────────────────────────────────────

export function visitImportDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const imp = node as ImportDeclaration;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;
  const source = imp.source.value;

  const result: VisitResult = { nodes: [], edges: [], deferred: [] };

  // EXTERNAL node for the source module
  const externalId = `${ctx.file}->EXTERNAL->${source}#0`;
  result.nodes.push({
    id: externalId,
    type: 'EXTERNAL',
    name: source,
    file: ctx.file,
    line,
    column,
  });
  // Also EXTERNAL_MODULE for golden matching
  const extModId = ctx.nodeId('EXTERNAL_MODULE', source, line);
  result.nodes.push({
    id: extModId,
    type: 'EXTERNAL_MODULE',
    name: source,
    file: ctx.file,
    line,
    column,
  });

  // DEPENDS_ON: module depends on external source
  result.edges.push({ src: ctx.moduleId, dst: externalId, type: 'DEPENDS_ON' });

  // Side-effect-only import: import './polyfill' (no specifiers)
  if (imp.specifiers.length === 0) {
    const sideEffectId = ctx.nodeId('SIDE_EFFECT', source, line);
    result.nodes.push({
      id: sideEffectId,
      type: 'SIDE_EFFECT',
      name: source,
      file: ctx.file,
      line,
      column,
      metadata: { importSource: source },
    });
    return result;
  }

  for (const spec of imp.specifiers) {
    const localName = spec.local.name;
    const imported = spec.type === 'ImportSpecifier'
      ? (spec as ImportSpecifier).imported : null;
    const importedName = spec.type === 'ImportDefaultSpecifier' ? 'default'
      : spec.type === 'ImportNamespaceSpecifier' ? '*'
      : imported?.type === 'Identifier' ? imported.name
      : imported ? String((imported as StringLiteral).value)
      : localName;

    const nodeId = ctx.nodeId('IMPORT', localName, line);

    result.nodes.push({
      id: nodeId,
      type: 'IMPORT',
      name: localName,
      file: ctx.file,
      line,
      column,
      metadata: { source, importedName },
    });

    // Register in scope so scope_lookup finds imports
    ctx.declare(localName, 'import', nodeId);

    // IMPORTS: module imports this specifier
    result.edges.push({ src: ctx.moduleId, dst: nodeId, type: 'IMPORTS' });

    // Deferred: resolve actual module
    result.deferred.push({
      kind: 'import_resolve',
      name: importedName,
      source,
      fromNodeId: nodeId,
      edgeType: 'IMPORTS_FROM',
      file: ctx.file,
      line,
      column,
    });

    // ALIASES: import { X as Y } → Y aliases X (cross-file, project stage)
    if (importedName !== localName && importedName !== 'default' && importedName !== '*') {
      result.deferred.push({
        kind: 'alias_resolve',
        name: importedName,
        source,
        fromNodeId: nodeId,
        edgeType: 'ALIASES',
        file: ctx.file,
        line,
        column,
      });
    }
  }

  return result;
}

// ─── ExportNamedDeclaration ──────────────────────────────────────────

export function visitExportNamedDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const exp = node as ExportNamedDeclaration;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;

  const result: VisitResult = { nodes: [], edges: [], deferred: [] };

  // Re-exports: export { x } from './other'
  if (exp.source) {
    const reExportSource = exp.source.value;
    const reExternalId = `${ctx.file}->EXTERNAL->${reExportSource}#0`;
    result.nodes.push({
      id: reExternalId,
      type: 'EXTERNAL',
      name: reExportSource,
      file: ctx.file,
      line,
      column,
    });
    const reExtModId = ctx.nodeId('EXTERNAL_MODULE', reExportSource, line);
    result.nodes.push({
      id: reExtModId,
      type: 'EXTERNAL_MODULE',
      name: reExportSource,
      file: ctx.file,
      line,
      column,
    });
    for (const spec of exp.specifiers) {
      if (spec.type === 'ExportSpecifier') {
        const exportedName = spec.exported.type === 'Identifier'
          ? spec.exported.name
          : String(spec.exported.value);
        const nodeId = ctx.nodeId('EXPORT', exportedName, line);
        result.nodes.push({
          id: nodeId,
          type: 'EXPORT',
          name: exportedName,
          file: ctx.file,
          line,
          column,
          exported: true,
        });
        result.deferred.push({
          kind: 'import_resolve',
          name: spec.local.name,
          source: exp.source.value,
          fromNodeId: nodeId,
          edgeType: 'IMPORTS_FROM',
          file: ctx.file,
          line,
          column,
        });
      }
    }
    return result;
  }

  // Named exports: export { x, y }
  for (const spec of exp.specifiers) {
    if (spec.type === 'ExportSpecifier') {
      const exportedName = spec.exported.type === 'Identifier'
        ? spec.exported.name
        : String(spec.exported.value);
      const nodeId = ctx.nodeId('EXPORT', exportedName, line);
      result.nodes.push({
        id: nodeId,
        type: 'EXPORT',
        name: exportedName,
        file: ctx.file,
        line,
        column,
        exported: true,
      });
      result.deferred.push({
        kind: 'export_lookup',
        name: spec.local.name,
        fromNodeId: nodeId,
        edgeType: 'EXPORTS',
        file: ctx.file,
        line,
        column,
      });
    }
  }

  // `export const x = 1` / `export function foo()` / `export class Bar` / `export type T = ...`
  if (exp.declaration) {
    const decl = exp.declaration;
    const names: string[] = [];
    if (decl.type === 'VariableDeclaration') {
      for (const d of (decl as VariableDeclaration).declarations) {
        if (d.id.type === 'Identifier') names.push(d.id.name);
      }
    } else if (decl.type === 'FunctionDeclaration' || decl.type === 'TSDeclareFunction') {
      const fn = decl as FunctionDeclaration;
      if (fn.id) names.push(fn.id.name);
    } else if (decl.type === 'ClassDeclaration') {
      const cls = decl as ClassDeclaration;
      if (cls.id) names.push(cls.id.name);
    } else if (decl.type === 'TSInterfaceDeclaration') {
      names.push((decl as TSInterfaceDeclaration).id.name);
    } else if (decl.type === 'TSTypeAliasDeclaration') {
      names.push((decl as TSTypeAliasDeclaration).id.name);
    } else if (decl.type === 'TSEnumDeclaration') {
      names.push((decl as TSEnumDeclaration).id.name);
    } else if (decl.type === 'TSModuleDeclaration') {
      const mod = decl as TSModuleDeclaration;
      if (mod.id.type === 'Identifier') names.push(mod.id.name);
    }
    for (const name of names) {
      const nodeId = ctx.nodeId('EXPORT', name, line);
      result.nodes.push({
        id: nodeId,
        type: 'EXPORT',
        name,
        file: ctx.file,
        line,
        column,
        exported: true,
      });
      result.deferred.push({
        kind: 'export_lookup',
        name,
        fromNodeId: nodeId,
        edgeType: 'EXPORTS',
        file: ctx.file,
        line,
        column,
      });
    }
  }

  return result;
}

// ─── ExportDefaultDeclaration ────────────────────────────────────────

export function visitExportDefaultDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const line = node.loc?.start.line ?? 0;
  const nodeId = ctx.nodeId('EXPORT', 'default', line);
  return {
    nodes: [{
      id: nodeId,
      type: 'EXPORT',
      name: 'default',
      file: ctx.file,
      line,
      column: node.loc?.start.column ?? 0,
      exported: true,
    }],
    edges: [],
    deferred: [],
  };
}

// ─── ExportAllDeclaration ────────────────────────────────────────────

export function visitExportAllDeclaration(
  node: Node, _parent: Node | null, ctx: WalkContext,
): VisitResult {
  const exp = node as ExportAllDeclaration;
  const line = node.loc?.start.line ?? 0;
  const column = node.loc?.start.column ?? 0;
  const nodeId = ctx.nodeId('EXPORT', '*', line);
  const source = exp.source.value;
  const extId = ctx.nodeId('EXTERNAL_MODULE', source, line);
  return {
    nodes: [
      {
        id: nodeId,
        type: 'EXPORT',
        name: '*',
        file: ctx.file,
        line,
        column,
        exported: true,
        metadata: { source },
      },
      {
        id: extId,
        type: 'EXTERNAL_MODULE',
        name: source,
        file: ctx.file,
        line,
        column,
      },
    ],
    edges: [{ src: nodeId, dst: extId, type: 'IMPORTS_FROM' }],
    deferred: [{
      kind: 'import_resolve',
      name: '*',
      source,
      fromNodeId: nodeId,
      edgeType: 'IMPORTS_FROM',
      file: ctx.file,
      line,
      column,
    }],
  };
}

// ─── Import specifier passthrough ────────────────────────────────────

export function visitImportSpecifier(
  _node: Node, _parent: Node | null, _ctx: WalkContext,
): VisitResult {
  return EMPTY_RESULT;
}

export const visitImportDefaultSpecifier = visitImportSpecifier;
export const visitImportNamespaceSpecifier = visitImportSpecifier;
export const visitExportSpecifier = visitImportSpecifier;
