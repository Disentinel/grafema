import type { Resource, ResourceId, ResourceRegistry as IResourceRegistry } from '@grafema/types';

/**
 * In-memory Resource registry for a single pipeline run.
 * Created by Orchestrator at run start, cleared at run end.
 *
 * Thread safety: Not needed — Grafema runs plugins sequentially within
 * each phase. Plugins are toposorted and run one at a time.
 */
export class ResourceRegistryImpl implements IResourceRegistry {
  private resources = new Map<ResourceId, Resource>();

  getOrCreate<T extends Resource>(id: ResourceId, factory: () => T): T {
    let resource = this.resources.get(id);
    if (!resource) {
      resource = factory();
      if (resource.id !== id) {
        throw new Error(
          `Resource factory returned resource with id "${resource.id}" but expected "${id}"`
        );
      }
      this.resources.set(id, resource);
    }
    return resource as T;
  }

  get<T extends Resource>(id: ResourceId): T | undefined {
    return this.resources.get(id) as T | undefined;
  }

  has(id: ResourceId): boolean {
    return this.resources.has(id);
  }

  /** Clear all Resources. Called by Orchestrator at the end of a run. */
  clear(): void {
    this.resources.clear();
  }
}
