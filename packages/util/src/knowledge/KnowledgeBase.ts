/**
 * KnowledgeBase — in-memory index over git-tracked knowledge files.
 *
 * Scans knowledge/ directory, parses markdown files with YAML frontmatter,
 * builds an in-memory index for fast lookups. All mutations also write to disk.
 */

import { join } from 'path';
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { parseFrontmatter, parseKBNode, serializeKBNode, parseEdgesFile, appendEdge as appendEdgeToFile } from './parser.js';
import type { KBNode, KBNodeType, KBDecision, KBFact, KBEdge, KBStats, KBQueryFilter, KBLifecycle, ResolvedAddress, DanglingCodeRef } from './types.js';
import { SemanticAddressResolver } from './SemanticAddressResolver.js';
import type { ResolverBackend } from './SemanticAddressResolver.js';

/** Pluralized directory names for each node type */
const TYPE_DIR: Record<string, string> = {
  DECISION: 'decisions',
  FACT: 'facts',
  SESSION: 'sessions',
  COMMIT: 'commits',
  FILE_CHANGE: 'file-changes',
  AUTHOR: 'authors',
  TICKET: 'tickets',
  INCIDENT: 'incidents',
};

export class KnowledgeBase {
  private knowledgeDir: string;
  private nodes: Map<string, KBNode> = new Map();
  private edges: KBEdge[] = [];
  private loaded = false;
  private resolver: SemanticAddressResolver | null = null;

  constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
  }

  /**
   * Wire up a code graph backend for resolving semantic addresses.
   * Creates a SemanticAddressResolver that lazily resolves `relates_to`
   * and `applies_to` addresses to current code node IDs.
   */
  setBackend(backend: ResolverBackend): void {
    this.resolver = new SemanticAddressResolver(backend);
  }

  /**
   * Bump the resolver's generation counter, marking all cached resolutions stale.
   * Call after re-analysis so next resolve() re-queries the code graph.
   */
  invalidateResolutionCache(): void {
    this.resolver?.bumpGeneration();
  }

  /**
   * Resolve all code addresses in a node's relates_to (and applies_to for decisions).
   * KB-internal addresses (kb:...) pass through without backend query.
   * Returns empty array if no resolver is set.
   */
  async resolveReferences(node: KBNode): Promise<ResolvedAddress[]> {
    if (!this.resolver) return [];

    const addresses: string[] = [];
    if (node.relates_to) addresses.push(...node.relates_to);
    if (node.type === 'DECISION') {
      const d = node as KBDecision;
      if (d.applies_to) addresses.push(...d.applies_to);
    }

    // Filter to code addresses only (not kb: internal refs)
    const codeAddresses = addresses.filter(a => !a.startsWith('kb:'));
    if (codeAddresses.length === 0) return [];

    return this.resolver.resolveAll(codeAddresses);
  }

  /**
   * Find all KB nodes with code addresses that don't resolve to graph nodes.
   * Returns pairs of (KB node ID, dangling address).
   */
  async getDanglingCodeRefs(): Promise<DanglingCodeRef[]> {
    if (!this.resolver) return [];

    const results: DanglingCodeRef[] = [];

    for (const node of this.nodes.values()) {
      const resolved = await this.resolveReferences(node);
      for (const r of resolved) {
        if (r.status === 'dangling') {
          results.push({ nodeId: node.id, address: r.address });
        }
      }
    }

    return results;
  }

  /**
   * Scan knowledge directory recursively, parse all .md files, build index.
   * Malformed files are skipped with console.warn, don't crash.
   * Missing directory succeeds with empty index.
   */
  async load(): Promise<void> {
    this.nodes.clear();
    this.edges = [];

    if (!existsSync(this.knowledgeDir)) {
      this.loaded = true;
      return;
    }

    // Scan for .md files recursively
    const mdFiles = this.scanFiles(this.knowledgeDir, '.md');

    for (const filePath of mdFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(content);
        const node = parseKBNode(frontmatter, body, filePath);

        if (this.nodes.has(node.id)) {
          const existing = this.nodes.get(node.id)!;
          throw new Error(
            `ID collision: "${node.id}" exists in both ${existing.filePath} and ${filePath}`
          );
        }

        this.nodes.set(node.id, node);
      } catch (error) {
        // ID collisions should propagate — they're data integrity errors
        if (error instanceof Error && error.message.startsWith('ID collision:')) {
          throw error;
        }
        console.warn(`[KnowledgeBase] Skipping malformed file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Load edges
    const edgesPath = join(this.knowledgeDir, 'edges.yaml');
    try {
      this.edges = parseEdgesFile(edgesPath);
    } catch (error) {
      console.warn(`[KnowledgeBase] Failed to parse edges.yaml: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.loaded = true;
  }

  /**
   * Get a node by its semantic ID.
   */
  getNode(id: string): KBNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Query nodes with filters. All filters are AND-combined.
   * When include_dangling_only is true, only returns nodes with dangling code refs.
   * Note: include_dangling_only requires a resolver backend; without one it returns empty.
   */
  async queryNodes(filter: KBQueryFilter): Promise<KBNode[]> {
    let results = Array.from(this.nodes.values());

    if (filter.type) {
      results = results.filter(n => n.type === filter.type);
    }
    if (filter.projection) {
      results = results.filter(n => n.projections.includes(filter.projection!));
    }
    if (filter.text) {
      const lower = filter.text.toLowerCase();
      results = results.filter(n => n.content.toLowerCase().includes(lower));
    }
    if (filter.status) {
      results = results.filter(n => {
        if (n.type === 'DECISION') return (n as KBDecision).status === filter.status;
        return false;
      });
    }
    if (filter.relates_to) {
      results = results.filter(n => n.relates_to?.includes(filter.relates_to!));
    }
    if (filter.include_dangling_only) {
      if (!this.resolver) return [];
      const danglingNodeIds = new Set<string>();
      for (const node of results) {
        const resolved = await this.resolveReferences(node);
        if (resolved.some(r => r.status === 'dangling')) {
          danglingNodeIds.add(node.id);
        }
      }
      results = results.filter(n => danglingNodeIds.has(n.id));
    }

    return results;
  }

  /**
   * Find active decisions that apply to a given module/semantic address.
   * Uses string includes matching on applies_to entries.
   */
  async activeDecisionsFor(module: string): Promise<KBDecision[]> {
    const decisions = await this.queryNodes({ type: 'DECISION', status: 'active' }) as KBDecision[];
    return decisions.filter(d =>
      d.applies_to?.some(addr => addr.includes(module) || module.includes(addr))
    );
  }

  /**
   * Add a new node to the knowledge base.
   * Creates the .md file on disk and updates the in-memory index.
   *
   * @param params - Node properties. `id` and `filePath` are auto-generated.
   * @returns The created node.
   */
  async addNode(params: {
    type: KBNodeType;
    content: string;
    slug?: string;
    projections?: string[];
    source?: string;
    relates_to?: string[];
    // Decision-specific
    status?: KBDecision['status'];
    effective_from?: string;
    applies_to?: string[];
    // Fact-specific
    confidence?: KBFact['confidence'];
    // Session-specific
    task_id?: string;
    session_path?: string;
    produced?: string[];
  }): Promise<KBNode> {
    const slug = params.slug || this.generateSlug(params.content);
    const typeLower = params.type.toLowerCase();
    const id = `kb:${typeLower}:${slug}`;

    // Collision check
    if (this.nodes.has(id)) {
      throw new Error(
        `Slug collision: "${id}" already exists. Did you mean to supersede? Use supersedeFact() for facts.`
      );
    }

    const typeDir = TYPE_DIR[params.type] || typeLower + 's';
    const dir = join(this.knowledgeDir, 'declared', typeDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const fileName = `${slug}.md`;
    const filePath = join(dir, fileName);

    // Secondary collision guard — file on disk
    if (existsSync(filePath)) {
      throw new Error(`File already exists: ${filePath}`);
    }

    const created = new Date().toISOString().split('T')[0];

    // Build frontmatter
    const frontmatter: Record<string, unknown> = {
      id,
      type: params.type,
      created,
    };
    if (params.projections?.length) frontmatter.projections = params.projections;
    if (params.source) frontmatter.source = params.source;
    if (params.relates_to?.length) frontmatter.relates_to = params.relates_to;

    // Decision fields
    if (params.type === 'DECISION') {
      frontmatter.status = params.status || 'proposed';
      if (params.applies_to?.length) frontmatter.applies_to = params.applies_to;
      if (params.effective_from) frontmatter.effective_from = params.effective_from;
    }

    // Fact fields
    if (params.type === 'FACT') {
      if (params.confidence) frontmatter.confidence = params.confidence;
    }

    // Session fields
    if (params.type === 'SESSION') {
      if (params.task_id) frontmatter.task_id = params.task_id;
      if (params.session_path) frontmatter.session_path = params.session_path;
      if (params.produced?.length) frontmatter.produced = params.produced;
    }

    // Parse to get a proper node, then serialize
    const node = parseKBNode(frontmatter, params.content, filePath);
    const markdown = serializeKBNode(node);
    writeFileSync(filePath, markdown, 'utf-8');

    // Update index
    this.nodes.set(id, node);

    // Create edges for relates_to
    if (params.relates_to?.length) {
      const edgesPath = join(this.knowledgeDir, 'edges.yaml');
      for (const target of params.relates_to) {
        const edge: KBEdge = { type: 'RELATES_TO', from: id, to: target };
        appendEdgeToFile(edgesPath, edge);
        this.edges.push(edge);
      }
    }

    return node;
  }

  /**
   * Supersede an existing fact with a new version.
   * Creates new fact, updates old fact with superseded_by.
   */
  async supersedeFact(
    oldId: string,
    newContent: string,
    newSlug?: string,
  ): Promise<{ old: KBFact; new: KBFact }> {
    const oldNode = this.nodes.get(oldId);
    if (!oldNode) {
      throw new Error(`Fact not found: ${oldId}`);
    }
    if (oldNode.type !== 'FACT') {
      throw new Error(`Node "${oldId}" is type ${oldNode.type}, not FACT. Only facts can be superseded.`);
    }

    const oldFact = oldNode as KBFact;
    const slug = newSlug || this.generateSlug(newContent);
    const newId = `kb:fact:${slug}`;

    // Create new fact
    const newFact = await this.addNode({
      type: 'FACT',
      content: newContent,
      slug,
      projections: oldFact.projections,
      source: oldFact.source,
      confidence: oldFact.confidence,
    }) as KBFact;

    // Update old fact: set superseded_by and rewrite file
    oldFact.superseded_by = newId;
    const markdown = serializeKBNode(oldFact);
    writeFileSync(oldFact.filePath, markdown, 'utf-8');

    // Add supersedes edge
    const edgesPath = join(this.knowledgeDir, 'edges.yaml');
    const edge: KBEdge = { type: 'SUPERSEDES', from: newId, to: oldId };
    appendEdgeToFile(edgesPath, edge);
    this.edges.push(edge);

    return { old: oldFact, new: newFact };
  }

  /**
   * Add an edge to the knowledge graph.
   */
  addEdge(edge: KBEdge): void {
    const edgesPath = join(this.knowledgeDir, 'edges.yaml');
    appendEdgeToFile(edgesPath, edge);
    this.edges.push(edge);
  }

  /**
   * Get edges, optionally filtered by node ID (from or to).
   */
  getEdges(nodeId?: string): KBEdge[] {
    if (!nodeId) return [...this.edges];
    return this.edges.filter(e => e.from === nodeId || e.to === nodeId);
  }

  /**
   * Get statistics about the knowledge base.
   * Includes dangling code references if a resolver backend is available.
   */
  async getStats(): Promise<KBStats> {
    const byType: Partial<Record<KBNodeType, number>> = {};
    const byLifecycle: Partial<Record<KBLifecycle, number>> = {};

    for (const node of this.nodes.values()) {
      byType[node.type] = (byType[node.type] || 0) + 1;
      byLifecycle[node.lifecycle] = (byLifecycle[node.lifecycle] || 0) + 1;
    }

    const edgesByType: Record<string, number> = {};
    for (const edge of this.edges) {
      edgesByType[edge.type] = (edgesByType[edge.type] || 0) + 1;
    }

    // Find dangling KB-internal refs
    const nodeIds = new Set(this.nodes.keys());
    const danglingRefs: string[] = [];
    for (const edge of this.edges) {
      if (!nodeIds.has(edge.from) && !danglingRefs.includes(edge.from)) {
        danglingRefs.push(edge.from);
      }
      if (!nodeIds.has(edge.to) && !danglingRefs.includes(edge.to)) {
        danglingRefs.push(edge.to);
      }
    }

    // Find dangling code references
    const danglingCodeRefs = await this.getDanglingCodeRefs();

    return {
      totalNodes: this.nodes.size,
      byType,
      byLifecycle,
      totalEdges: this.edges.length,
      edgesByType,
      danglingRefs,
      danglingCodeRefs,
    };
  }

  // --- Private helpers ---

  /**
   * Recursively scan directory for files with given extension.
   */
  private scanFiles(dir: string, ext: string): string[] {
    const results: string[] = [];

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...this.scanFiles(fullPath, ext));
        } else if (entry.endsWith(ext)) {
          results.push(fullPath);
        }
      } catch {
        // Skip unreadable entries
      }
    }
    return results;
  }

  /**
   * Generate a slug from content (first line, simplified).
   */
  private generateSlug(content: string): string {
    const firstLine = content.split('\n')[0].trim();
    return firstLine
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'untitled';
  }
}
