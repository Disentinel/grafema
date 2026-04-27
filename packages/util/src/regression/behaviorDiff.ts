/**
 * behaviorDiff — Layer 1 of the regression-test infrastructure (REG-1117).
 *
 * Compares two snapshots of FEATURE → BEHAVIOR metadata and produces a
 * deterministic, categorised diff. Pure function, no IO. The semantic
 * regression layer above (`test/unit/behaviorGolden.test.js`) loads a
 * golden file and current graph state into two `Map<featureId, BehaviorMeta>`
 * inputs, calls `diffBehaviors`, and reports the result.
 *
 * Categorisation rationale: BEHAVIOR.hash IS the implementation identity.
 * Any hash change is a real change in the function's transitive call closure
 * — but it could be benign (refactor that preserves semantics) or an actual
 * regression. We don't try to disambiguate; we emit the diff and let the
 * test author / CI gate decide whether to update the golden.
 *
 * See `_ai/research/feature-taxonomy.md` §1.4 for BEHAVIOR identity.
 */

/** A snapshot of one BEHAVIOR's metadata for golden comparison. */
export interface BehaviorMeta {
  /** sha256 of sort(transitive_call_targets) — the behavior's identity. */
  hash: string;
  /** Transitive effect set (sorted). */
  effects: string[];
  /** Forward-slice size. Summary statistic, included for diagnostic context. */
  coreNodeCount: number;
  /** Forward-slice depth used during analysis. */
  depth: number;
}

/** Categorised list of changes between two BehaviorMeta snapshots. */
export interface BehaviorDiff {
  /** Features present in current but not in golden. */
  added: string[];
  /** Features present in golden but not in current. */
  removed: string[];
  /** Features whose BEHAVIOR.hash changed (most-significant signal). */
  hashChanged: BehaviorHashChange[];
  /** Features where hash stayed but effect set changed (rare; effect-db drift). */
  effectsChangedSameHash: BehaviorEffectsChange[];
}

export interface BehaviorHashChange {
  featureId: string;
  oldHash: string;
  newHash: string;
  oldCoreNodeCount: number;
  newCoreNodeCount: number;
  /** Effects added in new hash. */
  effectsAdded: string[];
  /** Effects removed compared to golden. */
  effectsRemoved: string[];
}

export interface BehaviorEffectsChange {
  featureId: string;
  /** Same hash for both snapshots. */
  hash: string;
  effectsAdded: string[];
  effectsRemoved: string[];
}

/**
 * Compute a categorised diff between golden and current behaviors.
 *
 * Output is deterministic: feature IDs sorted lexicographically, effect
 * arrays sorted, all categories present (possibly empty).
 *
 * `golden` is treated as authoritative baseline. `current` is what's in the
 * graph right now. "Added" = in current only; "removed" = in golden only.
 */
export function diffBehaviors(
  golden: ReadonlyMap<string, BehaviorMeta>,
  current: ReadonlyMap<string, BehaviorMeta>,
): BehaviorDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const hashChanged: BehaviorHashChange[] = [];
  const effectsChangedSameHash: BehaviorEffectsChange[] = [];

  // Feature IDs in current but not in golden → added.
  for (const id of current.keys()) {
    if (!golden.has(id)) added.push(id);
  }
  // Feature IDs in golden but not in current → removed.
  for (const id of golden.keys()) {
    if (!current.has(id)) removed.push(id);
  }

  // Features in both: classify by hash and effect set.
  for (const id of golden.keys()) {
    const oldMeta = golden.get(id);
    const newMeta = current.get(id);
    if (!oldMeta || !newMeta) continue;

    if (oldMeta.hash !== newMeta.hash) {
      hashChanged.push({
        featureId: id,
        oldHash: oldMeta.hash,
        newHash: newMeta.hash,
        oldCoreNodeCount: oldMeta.coreNodeCount,
        newCoreNodeCount: newMeta.coreNodeCount,
        effectsAdded: setDiff(newMeta.effects, oldMeta.effects),
        effectsRemoved: setDiff(oldMeta.effects, newMeta.effects),
      });
      continue;
    }

    // Same hash — compare effects. Effects can drift if effects-db is updated
    // but the function body is unchanged (effect annotation added for a
    // builtin call that was already there).
    const eAdded = setDiff(newMeta.effects, oldMeta.effects);
    const eRemoved = setDiff(oldMeta.effects, newMeta.effects);
    if (eAdded.length > 0 || eRemoved.length > 0) {
      effectsChangedSameHash.push({
        featureId: id,
        hash: oldMeta.hash,
        effectsAdded: eAdded,
        effectsRemoved: eRemoved,
      });
    }
  }

  added.sort();
  removed.sort();
  hashChanged.sort((a, b) => a.featureId.localeCompare(b.featureId));
  effectsChangedSameHash.sort((a, b) => a.featureId.localeCompare(b.featureId));

  return { added, removed, hashChanged, effectsChangedSameHash };
}

/** Total number of changes across all categories — useful for CI gates. */
export function behaviorDiffSize(diff: BehaviorDiff): number {
  return (
    diff.added.length +
    diff.removed.length +
    diff.hashChanged.length +
    diff.effectsChangedSameHash.length
  );
}

/**
 * Render the diff as a multi-line human-readable report. Stable line order
 * matches the deterministic sort applied in `diffBehaviors`.
 */
export function formatBehaviorDiff(diff: BehaviorDiff): string {
  const lines: string[] = [];
  if (behaviorDiffSize(diff) === 0) {
    return 'No behavior changes vs golden.';
  }
  if (diff.added.length > 0) {
    lines.push(`Added features (${diff.added.length}):`);
    for (const id of diff.added) lines.push(`  + ${id}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`Removed features (${diff.removed.length}):`);
    for (const id of diff.removed) lines.push(`  - ${id}`);
  }
  if (diff.hashChanged.length > 0) {
    lines.push(`Hash changed (${diff.hashChanged.length}):`);
    for (const c of diff.hashChanged) {
      lines.push(
        `  ~ ${c.featureId}: ${c.oldHash.slice(0, 10)}…→${c.newHash.slice(0, 10)}…  ` +
        `core ${c.oldCoreNodeCount}→${c.newCoreNodeCount}`,
      );
      if (c.effectsAdded.length > 0) {
        lines.push(`      +effects: ${c.effectsAdded.join(', ')}`);
      }
      if (c.effectsRemoved.length > 0) {
        lines.push(`      -effects: ${c.effectsRemoved.join(', ')}`);
      }
    }
  }
  if (diff.effectsChangedSameHash.length > 0) {
    lines.push(`Effects changed (same hash) (${diff.effectsChangedSameHash.length}):`);
    for (const c of diff.effectsChangedSameHash) {
      const adds = c.effectsAdded.length ? `+${c.effectsAdded.join(',')}` : '';
      const rems = c.effectsRemoved.length ? `-${c.effectsRemoved.join(',')}` : '';
      lines.push(`  ~ ${c.featureId}  ${adds} ${rems}`.trimEnd());
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function setDiff(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  const out: string[] = [];
  for (const x of a) if (!bSet.has(x)) out.push(x);
  out.sort();
  return out;
}
