/**
 * Shared helper: project FEATURE → effect-set from BEHAVIOR nodes.
 *
 * Same algorithm as collectBehaviors but only returns the sorted effect
 * array per feature. Kept separate so the regen scripts and layer tests
 * can reuse it.
 */

import { collectBehaviors } from './collectBehaviors.js';

/**
 * @param {object} client
 * @returns {Promise<Map<string, string[]>>}
 */
export async function collectEffectSurfaces(client) {
  const behaviors = await collectBehaviors(client);
  const out = new Map();
  for (const [k, v] of behaviors) {
    out.set(k, [...v.effects].sort());
  }
  return out;
}
