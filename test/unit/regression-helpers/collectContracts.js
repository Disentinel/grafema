/**
 * Shared helper: enumerate every FEATURE → SPECED_CONTRACT pair and
 * project to (featureKey, SpecedContractData).
 *
 * featureKey = `${featureType}:${featureName}` (matches collectBehaviors).
 * Also returns categoryByFeatureKey so contractDiff can detect cli reorder.
 */

/**
 * @param {object} client
 * @returns {Promise<{contracts: Map<string, object>, categories: Map<string, string>}>}
 */
export async function collectContracts(client) {
  const contracts = new Map();
  const categories = new Map();

  const nodes = [];
  for await (const wn of client.queryNodes({ type: 'SPECED_CONTRACT' })) {
    nodes.push(wn);
  }

  for (const wn of nodes) {
    const data = parseMeta(wn);
    if (!data || typeof data.source !== 'string') continue;

    const incoming = await client.getIncomingEdges(wn.id, ['HAS_SPECED_CONTRACT']);
    if (incoming.length === 0) continue;
    const featureWireId = String(incoming[0].src);
    const feature = await client.getNode(featureWireId);
    if (!feature) continue;
    const featureType = String(feature.nodeType ?? feature.type ?? '');
    const featureName = String(feature.name ?? '');
    if (!featureType) continue;
    const key = `${featureType}:${featureName}`;

    contracts.set(key, normalizeSpec(data));
    categories.set(key, featureType);
  }

  return { contracts, categories };
}

/**
 * Normalize the spec to a stable serializable shape. Strips description
 * fields (cosmetic, ignored by diff). Sorts errors by type — inputs and
 * outputs preserve source order so reorder detection works.
 */
function normalizeSpec(data) {
  const inputs = (data.inputs ?? []).map((i) => ({
    name: String(i.name ?? ''),
    type: typeof i.type === 'string' ? i.type : undefined,
    optional: !!i.optional,
  }));
  const outputs = (data.outputs ?? []).map((o) => ({
    name: typeof o.name === 'string' ? o.name : undefined,
    type: typeof o.type === 'string' ? o.type : undefined,
  }));
  const errors = [...(data.errors ?? [])]
    .map((e) => ({ type: String(e.type ?? '') }))
    .sort((a, b) => a.type.localeCompare(b.type));
  return { source: data.source, inputs, outputs, errors };
}

function parseMeta(wn) {
  if (!wn) return null;
  if (typeof wn.metadata === 'string' && wn.metadata.length > 0) {
    try {
      return JSON.parse(wn.metadata);
    } catch {
      return null;
    }
  }
  return null;
}
