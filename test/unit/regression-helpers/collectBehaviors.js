/**
 * Shared helper for layer tests AND regen scripts: enumerate every
 * FEATURE → BEHAVIOR pair from a graph and project to BehaviorMeta.
 *
 * Works against any client that exposes:
 *   client.queryNodes({type})       — wire format (metadata: JSON string)
 *   client.getIncomingEdges(id, [t])
 *
 * Returns Map<featureKey, BehaviorMeta> where featureKey is
 * `${featureType}:${featureName}` — stable across runs even when RFDB
 * remaps numeric IDs across analyses.
 */

/**
 * @param {object} client RFDBClient or TestRFDB-wrapped client.
 * @returns {Promise<Map<string, {hash:string, effects:string[], coreNodeCount:number, depth:number}>>}
 */
export async function collectBehaviors(client) {
  /** @type {Map<string, {hash:string, effects:string[], coreNodeCount:number, depth:number}>} */
  const out = new Map();

  // 1. List BEHAVIOR nodes (wire format).
  const behaviors = [];
  for await (const wn of client.queryNodes({ type: 'BEHAVIOR' })) {
    behaviors.push(wn);
  }

  // 2. For each behavior, find the FEATURE that points at it via IMPLEMENTED_BY.
  for (const wn of behaviors) {
    const meta = parseMeta(wn);
    const hash = readString(meta.hash);
    if (!hash) continue;
    const effects = readStringArray(meta.effects);
    const coreNodeCount = readNumber(meta.coreNodeCount) ?? 0;
    const depth = readNumber(meta.depth) ?? 0;

    const incoming = await client.getIncomingEdges(wn.id, ['IMPLEMENTED_BY']);
    if (incoming.length === 0) continue;
    const featureWireId = String(incoming[0].src);
    const feature = await client.getNode(featureWireId);
    if (!feature) continue;

    const featureType = readString(feature.nodeType ?? feature.type);
    const featureName = readString(feature.name) ?? '';
    if (!featureType) continue;

    const key = `${featureType}:${featureName}`;
    // Sort effects for determinism.
    const sortedEffects = [...effects].sort();
    out.set(key, { hash, effects: sortedEffects, coreNodeCount, depth });
  }

  return out;
}

/**
 * Variant for backends that already flatten metadata (RFDBServerBackend
 * exposed via featuresAction). Used by the regen script when the user
 * supplied a backend instead of a raw client.
 */
export async function collectBehaviorsFromBackend(backend) {
  const out = new Map();
  const behaviors = [];
  for await (const node of backend.queryNodes({ type: 'BEHAVIOR' })) {
    behaviors.push(node);
  }
  for (const node of behaviors) {
    const id = String(node.id ?? '');
    if (!id) continue;
    const hash = readString(node.hash);
    if (!hash) continue;
    const effects = readStringArray(node.effects);
    const coreNodeCount = readNumber(node.coreNodeCount) ?? 0;
    const depth = readNumber(node.depth) ?? 0;

    const incoming = await backend.getIncomingEdges(id, ['IMPLEMENTED_BY']);
    if (incoming.length === 0) continue;
    const featureId = String(incoming[0].src);
    const feature = await backend.getNode(featureId);
    if (!feature) continue;
    const featureType = readString(feature.type ?? feature.nodeType);
    const featureName = readString(feature.name) ?? '';
    if (!featureType) continue;
    const key = `${featureType}:${featureName}`;
    out.set(key, { hash, effects: [...effects].sort(), coreNodeCount, depth });
  }
  return out;
}

function parseMeta(wn) {
  if (!wn) return {};
  if (typeof wn.metadata === 'string' && wn.metadata.length > 0) {
    try {
      return JSON.parse(wn.metadata);
    } catch {
      return {};
    }
  }
  return {};
}

function readString(v) {
  return typeof v === 'string' ? v : undefined;
}
function readNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function readStringArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.filter((x) => typeof x === 'string');
    } catch {
      /* not json */
    }
  }
  return [];
}
