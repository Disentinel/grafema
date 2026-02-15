/**
 * Resource Types — shared typed data containers for inter-plugin communication.
 *
 * Resources are created during a pipeline run and destroyed when the run ends.
 * Multiple plugins can write to a Resource; any plugin can read from it.
 *
 * Unlike graph nodes, Resources are:
 * - Not persisted to RFDB
 * - Not queryable via Datalog
 * - Typed (each Resource has a known interface)
 * - Scoped to a single pipeline run
 *
 * Resources are for structured data that plugins share but that doesn't
 * belong in the code graph (config-derived rules, computed indexes, etc.).
 */

/**
 * Unique identifier for a Resource type.
 * Convention: 'domain:name' (e.g., 'routing:map', 'auth:policies').
 */
export type ResourceId = string;

/**
 * Base interface for all Resources.
 */
export interface Resource {
  /** Unique identifier for this Resource type */
  readonly id: ResourceId;
}

/**
 * Registry for managing Resources during a pipeline run.
 * The Orchestrator creates one ResourceRegistry per run.
 * Plugins access it via PluginContext.
 */
export interface ResourceRegistry {
  /**
   * Get or create a Resource by ID.
   * If the Resource doesn't exist yet, creates it using the factory.
   * If it already exists, returns the existing instance (factory ignored).
   *
   * @param id - Resource identifier
   * @param factory - Factory function to create the Resource if it doesn't exist
   * @returns The Resource instance (existing or newly created)
   */
  getOrCreate<T extends Resource>(id: ResourceId, factory: () => T): T;

  /**
   * Get a Resource by ID. Returns undefined if not yet created.
   * Use this when a plugin wants to READ a Resource but should not create it.
   */
  get<T extends Resource>(id: ResourceId): T | undefined;

  /**
   * Check if a Resource exists.
   */
  has(id: ResourceId): boolean;
}
