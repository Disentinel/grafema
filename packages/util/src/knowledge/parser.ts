/**
 * Knowledge Base Parser
 *
 * Parses markdown files with YAML frontmatter into KBNode objects.
 * Serializes KBNode objects back to markdown format.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { KBNode, KBNodeType, KBEdge, KBLifecycle, KBDecision, KBFact, KBSession, KBScope } from './types.js';

const VALID_TYPES: KBNodeType[] = ['DECISION', 'FACT', 'SESSION', 'COMMIT', 'FILE_CHANGE', 'AUTHOR', 'TICKET', 'INCIDENT'];
const ID_PATTERN = /^kb:[a-z_]+:[a-z0-9_-]+$/;

/**
 * Split markdown content into YAML frontmatter and body.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---\n') && !trimmed.startsWith('---\r\n')) {
    throw new Error('Missing frontmatter: file must start with ---');
  }

  // Find closing --- delimiter
  const firstNewline = trimmed.indexOf('\n');
  const rest = trimmed.slice(firstNewline + 1);
  const closingIndex = rest.indexOf('\n---');

  if (closingIndex === -1) {
    throw new Error('Missing frontmatter: no closing --- delimiter found');
  }

  const yamlContent = rest.slice(0, closingIndex);
  const body = rest.slice(closingIndex + 4).replace(/^\r?\n/, ''); // skip \n--- and leading newline

  const frontmatter = parseYaml(yamlContent) as Record<string, unknown>;
  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error('Invalid frontmatter: YAML must be an object');
  }

  return { frontmatter, body };
}

/**
 * Derive lifecycle from file path.
 * declared/ → declared, derived/ → derived, synced/ → synced
 */
function deriveLifecycle(filePath: string): KBLifecycle {
  if (filePath.includes('/derived/') || filePath.includes('\\derived\\')) return 'derived';
  if (filePath.includes('/synced/') || filePath.includes('\\synced\\')) return 'synced';
  return 'declared'; // default
}

/**
 * Validate and construct a typed KBNode from parsed frontmatter and body.
 */
export function parseKBNode(frontmatter: Record<string, unknown>, body: string, filePath: string): KBNode {
  // Required: id
  const id = frontmatter.id;
  if (typeof id !== 'string' || !id) {
    throw new Error(`Missing required field "id" in ${filePath}`);
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid ID format "${id}" in ${filePath}. Must match kb:<type>:<slug> (lowercase, hyphens, underscores, digits)`);
  }

  // Required: type
  const type = frontmatter.type;
  if (typeof type !== 'string' || !VALID_TYPES.includes(type as KBNodeType)) {
    throw new Error(`Invalid or missing type "${type}" in ${filePath}. Must be one of: ${VALID_TYPES.join(', ')}`);
  }

  const lifecycle = deriveLifecycle(filePath);

  // Base node
  const base: KBNode = {
    id: id as string,
    type: type as KBNodeType,
    projections: Array.isArray(frontmatter.projections) ? frontmatter.projections as string[] : [],
    created: String(frontmatter.created ?? ''),
    content: body.trim(),
    filePath,
    lifecycle,
  };

  // Optional base fields
  if (frontmatter.subtype) base.subtype = String(frontmatter.subtype);
  if (frontmatter.scope) base.scope = frontmatter.scope as KBScope;
  if (frontmatter.source) base.source = String(frontmatter.source);
  if (Array.isArray(frontmatter.relates_to)) base.relates_to = frontmatter.relates_to as string[];

  // Type-specific fields
  switch (type) {
    case 'DECISION': {
      const decision = base as KBDecision;
      decision.status = (frontmatter.status as KBDecision['status']) ?? 'proposed';
      if (frontmatter.effective_from) decision.effective_from = String(frontmatter.effective_from);
      if (frontmatter.effective_until) decision.effective_until = String(frontmatter.effective_until);
      if (Array.isArray(frontmatter.applies_to)) decision.applies_to = frontmatter.applies_to as string[];
      if (frontmatter.superseded_by) decision.superseded_by = String(frontmatter.superseded_by);
      return decision;
    }
    case 'FACT': {
      const fact = base as KBFact;
      if (frontmatter.confidence) fact.confidence = frontmatter.confidence as KBFact['confidence'];
      if (frontmatter.superseded_by) fact.superseded_by = String(frontmatter.superseded_by);
      return fact;
    }
    case 'SESSION': {
      const session = base as KBSession;
      if (frontmatter.task_id) session.task_id = String(frontmatter.task_id);
      if (frontmatter.session_path) session.session_path = String(frontmatter.session_path);
      if (Array.isArray(frontmatter.produced)) session.produced = frontmatter.produced as string[];
      return session;
    }
    default:
      return base;
  }
}

/**
 * Serialize a KBNode back to markdown with YAML frontmatter.
 */
export function serializeKBNode(node: KBNode): string {
  // Build frontmatter object (exclude computed/internal fields)
  const fm: Record<string, unknown> = {
    id: node.id,
    type: node.type,
  };

  // Decision-specific
  if (node.type === 'DECISION') {
    const d = node as KBDecision;
    fm.status = d.status;
    if (d.applies_to?.length) fm.applies_to = d.applies_to;
    if (d.effective_from) fm.effective_from = d.effective_from;
    if (d.effective_until) fm.effective_until = d.effective_until;
    if (d.superseded_by) fm.superseded_by = d.superseded_by;
  }

  // Fact-specific
  if (node.type === 'FACT') {
    const f = node as KBFact;
    if (f.confidence) fm.confidence = f.confidence;
    if (f.superseded_by) fm.superseded_by = f.superseded_by;
  }

  // Session-specific
  if (node.type === 'SESSION') {
    const s = node as KBSession;
    if (s.task_id) fm.task_id = s.task_id;
    if (s.session_path) fm.session_path = s.session_path;
    if (s.produced?.length) fm.produced = s.produced;
  }

  // Common optional fields
  if (node.subtype) fm.subtype = node.subtype;
  if (node.scope) fm.scope = node.scope;
  if (node.projections.length > 0) fm.projections = node.projections;
  if (node.source) fm.source = node.source;
  if (node.relates_to?.length) fm.relates_to = node.relates_to;
  fm.created = node.created;

  const yamlStr = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
  const body = node.content ? `\n${node.content}\n` : '\n';

  return `---\n${yamlStr}\n---\n${body}`;
}

/**
 * Parse edges.yaml file into KBEdge array.
 */
export function parseEdgesFile(filePath: string): KBEdge[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);

  if (!parsed) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`edges.yaml must be a YAML array, got ${typeof parsed}`);
  }

  return parsed.map((entry: unknown, i: number) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Edge at index ${i} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (!e.type || !e.from || !e.to) {
      throw new Error(`Edge at index ${i} missing required fields (type, from, to)`);
    }
    const edge: KBEdge = {
      type: String(e.type),
      from: String(e.from),
      to: String(e.to),
    };
    if (e.evidence) edge.evidence = String(e.evidence);
    return edge;
  });
}

/**
 * Parse a YAML file containing an array of node objects (e.g., commits/2026-03.yaml, authors.yaml).
 * Each entry must have at least a `type` field. ID is generated based on type:
 * - COMMIT → kb:commit:<short-hash>
 * - AUTHOR → kb:author:<slug>
 * - Others → kb:<type>:<index>
 */
export function parseYamlArrayFile(filePath: string): KBNode[] {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);

  if (!Array.isArray(parsed)) {
    throw new Error(`YAML array file must contain an array, got ${typeof parsed} in ${filePath}`);
  }

  return parsed.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Entry at index ${index} is not an object in ${filePath}`);
    }
    const e = entry as Record<string, unknown>;

    const type = e.type;
    if (typeof type !== 'string' || !VALID_TYPES.includes(type as KBNodeType)) {
      throw new Error(`Invalid or missing type "${type}" at index ${index} in ${filePath}. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    // Generate ID based on type
    let id: string;
    switch (type) {
      case 'COMMIT':
        id = `kb:commit:${String(e.hash ?? '').slice(0, 8)}`;
        break;
      case 'AUTHOR': {
        if (typeof e.id === 'string' && e.id.startsWith('kb:author:')) {
          id = e.id;
        } else if (typeof e.id === 'string') {
          id = `kb:author:${e.id}`;
        } else {
          const name = String(e.name ?? '');
          id = `kb:author:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
        }
        break;
      }
      default:
        id = `kb:${type.toLowerCase()}:${index}`;
        break;
    }

    const base: KBNode = {
      id,
      type: type as KBNodeType,
      projections: Array.isArray(e.projections) ? e.projections as string[] : [],
      created: type === 'COMMIT' ? (String(e.date ?? '').split('T')[0]) : '',
      content: '',
      filePath,
      lifecycle: 'derived' as KBLifecycle,
    };

    // Spread all entry fields onto the node, preserving base fields
    const node: KBNode = { ...e, ...base } as KBNode;

    return node;
  });
}

/**
 * Append an edge to the edges.yaml file.
 */
export function appendEdge(filePath: string, edge: KBEdge): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const entry: Record<string, string> = {
    type: edge.type,
    from: edge.from,
    to: edge.to,
  };
  if (edge.evidence) entry.evidence = edge.evidence;

  const yamlEntry = stringifyYaml([entry], { lineWidth: 0 }).trimEnd();

  if (!existsSync(filePath)) {
    // New file — write with comment header
    const header = '# Knowledge Graph edges\n# Format: {type, from, to, evidence?}\n\n';
    appendFileSync(filePath, header + yamlEntry + '\n', 'utf-8');
  } else {
    // Append to existing file
    appendFileSync(filePath, '\n' + yamlEntry + '\n', 'utf-8');
  }
}
