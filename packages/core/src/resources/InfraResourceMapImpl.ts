import type { InfraResourceMap, ResourceMapping, AbstractResource, AbstractResourceType, ConcreteResourceRef } from '@grafema/types';
import { INFRA_RESOURCE_MAP_ID } from '@grafema/types';

/**
 * Default implementation of InfraResourceMap.
 *
 * Stores mappings indexed by abstractType -> name -> AbstractResource
 * for O(1) lookup. Multiple concrete resources can map to the same
 * abstract resource (e.g., K8s Deployment + Terraform both create compute:service:api).
 *
 * Complexity:
 * - register: O(1) amortized (map insertions)
 * - findAbstract: O(1) nested map lookup
 * - findByType: O(n) where n = resources of that type
 * - findByEnv: O(N) where N = total resources
 */
export class InfraResourceMapImpl implements InfraResourceMap {
  readonly id = INFRA_RESOURCE_MAP_ID;

  /** abstractType -> name -> AbstractResource */
  private byTypeAndName = new Map<string, Map<string, AbstractResource>>();
  /** abstractId -> AbstractResource for O(1) lookup */
  private byId = new Map<string, AbstractResource>();

  register(mapping: ResourceMapping): void {
    let nameMap = this.byTypeAndName.get(mapping.abstractType);
    if (!nameMap) {
      nameMap = new Map();
      this.byTypeAndName.set(mapping.abstractType, nameMap);
    }

    const provider: ConcreteResourceRef = {
      id: mapping.concreteId,
      type: mapping.concreteType,
      tool: mapping.sourceTool,
      file: mapping.sourceFile,
    };

    const existing = nameMap.get(mapping.name);
    if (existing) {
      // Deduplicate providers
      const isDuplicate = existing.providers.some(p => p.id === provider.id);
      if (!isDuplicate) {
        existing.providers.push(provider);
      }
      // Merge metadata (later registrations can add fields)
      existing.metadata = { ...existing.metadata, ...mapping.metadata };
      // Merge env
      if (mapping.env !== undefined) {
        existing.env = mergeEnv(existing.env, mapping.env);
      }
    } else {
      const abstract: AbstractResource = {
        id: mapping.abstractId,
        type: mapping.abstractType,
        name: mapping.name,
        env: mapping.env,
        metadata: { ...mapping.metadata },
        providers: [provider],
      };
      nameMap.set(mapping.name, abstract);
      this.byId.set(mapping.abstractId, abstract);
    }
  }

  findAbstract(name: string, type: AbstractResourceType): AbstractResource | null {
    return this.byTypeAndName.get(type)?.get(name) ?? null;
  }

  findConcrete(abstractId: string): ConcreteResourceRef[] {
    const abstract = this.byId.get(abstractId);
    return abstract ? [...abstract.providers] : [];
  }

  findByType(type: AbstractResourceType): AbstractResource[] {
    const nameMap = this.byTypeAndName.get(type);
    return nameMap ? [...nameMap.values()] : [];
  }

  findByEnv(env: string): AbstractResource[] {
    const result: AbstractResource[] = [];
    for (const abstract of this.byId.values()) {
      if (matchesEnv(abstract.env, env)) {
        result.push(abstract);
      }
    }
    return result;
  }

  getAll(): AbstractResource[] {
    return [...this.byId.values()];
  }

  get resourceCount(): number {
    return this.byId.size;
  }
}

/** Merge environment values, deduplicating */
function mergeEnv(existing: string | string[] | undefined, incoming: string | string[] | undefined): string | string[] | undefined {
  if (existing === undefined) return incoming;
  if (incoming === undefined) return existing;
  const existingArr = Array.isArray(existing) ? existing : [existing];
  const incomingArr = Array.isArray(incoming) ? incoming : [incoming];
  const merged = [...new Set([...existingArr, ...incomingArr])];
  return merged.length === 1 ? merged[0] : merged;
}

/** Check if resource env matches filter */
function matchesEnv(resourceEnv: string | string[] | undefined, filterEnv: string): boolean {
  if (resourceEnv === undefined) return true; // undefined = all environments
  if (Array.isArray(resourceEnv)) return resourceEnv.includes(filterEnv);
  return resourceEnv === filterEnv;
}

/** Factory function for creating an InfraResourceMap Resource */
export function createInfraResourceMap(): InfraResourceMapImpl {
  return new InfraResourceMapImpl();
}
