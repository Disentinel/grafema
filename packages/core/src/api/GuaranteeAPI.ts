/**
 * GuaranteeAPI - CRUD API for contract-based guarantees
 *
 * Contract-based guarantees use JSON schema validation instead of Datalog rules.
 * They have namespaced types: guarantee:queue, guarantee:api, guarantee:permission
 *
 * This API complements GuaranteeManager which handles Datalog-based GUARANTEE nodes.
 */

import type { ValidateFunction, ErrorObject } from 'ajv';
import { GuaranteeNode, type GuaranteeNodeRecord, type GuaranteePriority, type GuaranteeStatus, type GuaranteeType } from '../core/nodes/GuaranteeNode.js';

// Schema validator interface
interface SchemaValidator {
  compile(schema: Record<string, unknown>): ValidateFunction;
}

// Lazy-loaded Ajv instance to avoid import issues
let ajvInstance: SchemaValidator | null = null;

async function getAjv(): Promise<SchemaValidator> {
  if (!ajvInstance) {
    const AjvModule = await import('ajv');
    // Handle both ESM default export and CJS module.exports
    const AjvClass = AjvModule.default || AjvModule;
    // Use Function constructor pattern to avoid TS2351
    const createAjv = AjvClass as unknown as new (opts: { allErrors: boolean }) => SchemaValidator;
    ajvInstance = new createAjv({ allErrors: true });
  }
  return ajvInstance;
}

/**
 * Graph interface for GuaranteeAPI
 */
export interface GuaranteeGraphBackend {
  addNode(node: Record<string, unknown>): Promise<void>;
  getNode(id: string): Promise<Record<string, unknown> | null>;
  deleteNode(id: string): Promise<void>;
  queryNodes(filter: { type: string }): AsyncIterable<Record<string, unknown>>;
  addEdge(edge: { type: string; src: string; dst: string }): Promise<void>;
  deleteEdge(src: string, dst: string, type: string): Promise<void>;
  getOutgoingEdges(nodeId: string, types: string[]): Promise<Array<{ src: string; dst: string; type: string }>>;
  getIncomingEdges(nodeId: string, types: string[]): Promise<Array<{ src: string; dst: string; type: string }>>;
}

/**
 * Input for creating a guarantee
 */
export interface CreateGuaranteeInput {
  type: 'guarantee:queue' | 'guarantee:api' | 'guarantee:permission';
  name: string;
  priority?: GuaranteePriority;
  status?: GuaranteeStatus;
  owner?: string;
  schema?: Record<string, unknown>;
  condition?: string;
  description?: string;
  governs?: string[]; // Node IDs that this guarantee governs
}

/**
 * Input for updating a guarantee
 */
export interface UpdateGuaranteeInput {
  priority?: GuaranteePriority;
  status?: GuaranteeStatus;
  owner?: string;
  schema?: Record<string, unknown>;
  condition?: string;
  description?: string;
}

/**
 * Filter for finding guarantees
 */
export interface GuaranteeFilter {
  type?: GuaranteeType | GuaranteeType[];
  priority?: GuaranteePriority | GuaranteePriority[];
  status?: GuaranteeStatus | GuaranteeStatus[];
  owner?: string;
}

/**
 * Result of checking a guarantee
 */
export interface CheckGuaranteeResult {
  id: string;
  name: string;
  passed: boolean;
  errors: string[];
  validatedCount: number;
}

/**
 * GuaranteeAPI - CRUD operations for contract-based guarantees
 */
export class GuaranteeAPI {
  private graph: GuaranteeGraphBackend;
  private schemaCache: Map<string, ValidateFunction>;

  constructor(graph: GuaranteeGraphBackend) {
    this.graph = graph;
    this.schemaCache = new Map();
  }

  /**
   * Create a new contract-based guarantee
   */
  async createGuarantee(input: CreateGuaranteeInput): Promise<GuaranteeNodeRecord> {
    // Parse type to get namespace
    const parsed = GuaranteeNode.parseId(`${input.type}#${input.name}`);
    if (!parsed) {
      throw new Error(`Invalid guarantee type: ${input.type}`);
    }

    // Create the guarantee node
    const node = GuaranteeNode.create(parsed.namespace, input.name, {
      priority: input.priority,
      status: input.status,
      owner: input.owner,
      schema: input.schema,
      condition: input.condition,
      description: input.description,
    });

    // Validate before saving
    const errors = GuaranteeNode.validate(node);
    if (errors.length > 0) {
      throw new Error(`Invalid guarantee: ${errors.join(', ')}`);
    }

    // Save to graph
    await this.graph.addNode(node as unknown as Record<string, unknown>);

    // Create GOVERNS edges if specified
    if (input.governs && input.governs.length > 0) {
      for (const targetId of input.governs) {
        await this.addGoverns(node.id, targetId);
      }
    }

    return node;
  }

  /**
   * Get a guarantee by ID
   */
  async getGuarantee(id: string): Promise<GuaranteeNodeRecord | null> {
    const node = await this.graph.getNode(id);
    if (!node) return null;

    // Verify it's a guarantee type
    if (!GuaranteeNode.isGuaranteeType(node.type as string)) {
      return null;
    }

    return node as unknown as GuaranteeNodeRecord;
  }

  /**
   * Find guarantees matching filter
   */
  async findGuarantees(filter: GuaranteeFilter = {}): Promise<GuaranteeNodeRecord[]> {
    const guarantees: GuaranteeNodeRecord[] = [];
    const types = this.normalizeTypeFilter(filter.type);

    for (const type of types) {
      for await (const node of this.graph.queryNodes({ type })) {
        const g = node as unknown as GuaranteeNodeRecord;

        // Apply additional filters
        if (filter.priority) {
          const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority];
          if (!priorities.includes(g.priority)) continue;
        }

        if (filter.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
          if (!statuses.includes(g.status)) continue;
        }

        if (filter.owner && g.owner !== filter.owner) continue;

        guarantees.push(g);
      }
    }

    return guarantees;
  }

  /**
   * Update a guarantee
   */
  async updateGuarantee(id: string, updates: UpdateGuaranteeInput): Promise<GuaranteeNodeRecord> {
    const existing = await this.getGuarantee(id);
    if (!existing) {
      throw new Error(`Guarantee not found: ${id}`);
    }

    // Apply updates
    const updated: GuaranteeNodeRecord = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    // Validate
    const errors = GuaranteeNode.validate(updated);
    if (errors.length > 0) {
      throw new Error(`Invalid guarantee after update: ${errors.join(', ')}`);
    }

    // Delete old and add new (upsert)
    await this.graph.deleteNode(id);
    await this.graph.addNode(updated as unknown as Record<string, unknown>);

    return updated;
  }

  /**
   * Delete a guarantee
   */
  async deleteGuarantee(id: string): Promise<boolean> {
    const existing = await this.getGuarantee(id);
    if (!existing) {
      return false;
    }

    // Delete GOVERNS edges
    const edges = await this.graph.getOutgoingEdges(id, ['GOVERNS']);
    for (const edge of edges) {
      await this.graph.deleteEdge(edge.src, edge.dst, 'GOVERNS');
    }

    // Delete the node
    await this.graph.deleteNode(id);
    return true;
  }

  /**
   * Add GOVERNS edge from guarantee to a node
   */
  async addGoverns(guaranteeId: string, nodeId: string): Promise<void> {
    // Verify guarantee exists
    const guarantee = await this.getGuarantee(guaranteeId);
    if (!guarantee) {
      throw new Error(`Guarantee not found: ${guaranteeId}`);
    }

    // Verify target node exists
    const targetNode = await this.graph.getNode(nodeId);
    if (!targetNode) {
      throw new Error(`Target node not found: ${nodeId}`);
    }

    // Create GOVERNS edge
    await this.graph.addEdge({
      type: 'GOVERNS',
      src: guaranteeId,
      dst: nodeId,
    });
  }

  /**
   * Remove GOVERNS edge
   */
  async removeGoverns(guaranteeId: string, nodeId: string): Promise<void> {
    await this.graph.deleteEdge(guaranteeId, nodeId, 'GOVERNS');
  }

  /**
   * Get nodes governed by a guarantee
   */
  async getGoverned(guaranteeId: string): Promise<string[]> {
    const edges = await this.graph.getOutgoingEdges(guaranteeId, ['GOVERNS']);
    return edges.map(e => e.dst);
  }

  /**
   * Get guarantees governing a node
   */
  async getGoverningGuarantees(nodeId: string): Promise<GuaranteeNodeRecord[]> {
    const edges = await this.graph.getIncomingEdges(nodeId, ['GOVERNS']);
    const guarantees: GuaranteeNodeRecord[] = [];

    for (const edge of edges) {
      const g = await this.getGuarantee(edge.src);
      if (g) guarantees.push(g);
    }

    return guarantees;
  }

  /**
   * Check a guarantee using JSON schema validation
   * Returns validation results for governed nodes
   */
  async checkGuarantee(id: string): Promise<CheckGuaranteeResult> {
    const guarantee = await this.getGuarantee(id);
    if (!guarantee) {
      throw new Error(`Guarantee not found: ${id}`);
    }

    const result: CheckGuaranteeResult = {
      id,
      name: guarantee.name,
      passed: true,
      errors: [],
      validatedCount: 0,
    };

    // If no schema defined, consider it passing
    if (!guarantee.schema) {
      return result;
    }

    // Get or compile schema validator
    let validate: ValidateFunction | undefined = this.schemaCache.get(id);
    if (!validate) {
      try {
        const ajv = await getAjv();
        validate = ajv.compile(guarantee.schema);
        this.schemaCache.set(id, validate);
      } catch (e) {
        result.passed = false;
        result.errors.push(`Invalid schema: ${(e as Error).message}`);
        return result;
      }
    }

    // Get governed nodes and validate them
    const governedIds = await this.getGoverned(id);
    // At this point validate is guaranteed to be defined (we returned if compile failed)
    const validator: ValidateFunction = validate;
    for (const nodeId of governedIds) {
      const node = await this.graph.getNode(nodeId);
      if (!node) continue;

      result.validatedCount++;
      const valid = validator(node);
      if (!valid) {
        result.passed = false;
        const errors = validator.errors as ErrorObject[] | null | undefined;
        if (errors) {
          for (const err of errors) {
            result.errors.push(`${nodeId}: ${err.instancePath} ${err.message}`);
          }
        }
      }
    }

    return result;
  }

  /**
   * Check all guarantees
   */
  async checkAllGuarantees(): Promise<{
    total: number;
    passed: number;
    failed: number;
    results: CheckGuaranteeResult[];
  }> {
    const guarantees = await this.findGuarantees();
    const results: CheckGuaranteeResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const g of guarantees) {
      const result = await this.checkGuarantee(g.id);
      results.push(result);
      if (result.passed) passed++;
      else failed++;
    }

    return {
      total: guarantees.length,
      passed,
      failed,
      results,
    };
  }

  /**
   * Normalize type filter to array of types
   */
  private normalizeTypeFilter(type?: GuaranteeType | GuaranteeType[]): GuaranteeType[] {
    if (!type) {
      return GuaranteeNode.getTypes();
    }
    return Array.isArray(type) ? type : [type];
  }

  /**
   * Clear schema cache (useful after schema updates)
   */
  clearSchemaCache(): void {
    this.schemaCache.clear();
  }
}
