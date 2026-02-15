/**
 * Build dependency graph from plugin consumes/produces declarations (RFD-2).
 *
 * Two-layer dependency resolution:
 *
 * Layer 1 (automatic): If plugin A produces edge type E,
 *   and plugin B consumes edge type E, then B depends on A.
 *   Self-references (same plugin consumes what it produces) excluded.
 *
 * Layer 2 (explicit): metadata.dependencies merged in.
 *   Handles cross-phase deps and plugins without consumes/produces.
 *
 * Self-reference handling: When a plugin both consumes and produces the same
 * edge type (e.g., InstanceOfResolver rewires INSTANCE_OF edges), it does NOT
 * create a self-dependency. This is intentional — enrichers extend the graph.
 *
 * Opportunistic reading: If a plugin reads an edge type only for filtering
 * (e.g., "skip if CALLS edge exists"), it should NOT declare that in consumes.
 * Use explicit dependencies for the actual ordering constraint instead.
 *
 * Complexity: O(E + P) where E = plugins, P = total produces entries.
 */

import type { IPlugin, EdgeType } from '@grafema/types';
import type { ToposortItem } from './toposort.js';

/**
 * Result of building the enricher dependency graph.
 * Contains both the toposort items and a consumer index
 * for downstream propagation (RFD-17).
 */
export interface EnricherDependencyInfo {
  items: ToposortItem[];
  /** Maps edgeType → set of enricher names that consume that type */
  consumerIndex: Map<string, Set<string>>;
}

export function buildDependencyGraph(plugins: IPlugin[]): EnricherDependencyInfo {
  // Step 1: Build producer index — Map<EdgeType, pluginNames[]>
  const producers = new Map<EdgeType, string[]>();

  for (const plugin of plugins) {
    const meta = plugin.metadata;
    if (!meta.produces) continue;
    for (const edgeType of meta.produces) {
      let list = producers.get(edgeType);
      if (!list) {
        list = [];
        producers.set(edgeType, list);
      }
      list.push(meta.name);
    }
  }

  // Step 2: For each plugin, compute deps from consumes + explicit
  // Also build consumer index for downstream propagation (RFD-17)
  const consumerIndex = new Map<string, Set<string>>();

  const items = plugins.map(plugin => {
    const meta = plugin.metadata;
    const deps = new Set<string>();

    // Layer 1: Automatic inference from consumes/produces
    if (meta.consumes) {
      for (const edgeType of meta.consumes) {
        // Register in consumer index (RFD-17)
        let consumers = consumerIndex.get(edgeType);
        if (!consumers) {
          consumers = new Set();
          consumerIndex.set(edgeType, consumers);
        }
        consumers.add(meta.name);

        const edgeProducers = producers.get(edgeType);
        if (!edgeProducers) continue;
        for (const producerName of edgeProducers) {
          if (producerName !== meta.name) {
            deps.add(producerName);
          }
        }
      }
    }

    // Layer 2: Merge explicit dependencies
    if (meta.dependencies) {
      for (const dep of meta.dependencies) {
        deps.add(dep);
      }
    }

    return {
      id: meta.name,
      dependencies: [...deps],
    };
  });

  return { items, consumerIndex };
}
