/**
 * effectDiff — Layer 4 of the regression-test infrastructure (REG-1117).
 *
 * Compares two snapshots of FEATURE → effect set and categorises each
 * change by sensitivity:
 *
 *   - ESCALATION: an effect was *added* that increases trust-boundary
 *     concern. Currently FS_WRITE / NETWORK_OUT / DB_WRITE — anything that
 *     mutates data the user owns (filesystem) or sends data outbound.
 *     Adding one of these without intent is a security/correctness signal.
 *   - NOTE: any other diff (added IO read class, removed effect, etc.).
 *     Surface but don't fail by default.
 *
 * Pure function, deterministic ordering.
 */

/** The set of effects we currently treat as "elevated trust boundary". */
export const ESCALATION_EFFECTS = ['DB_WRITE', 'FS_WRITE', 'NETWORK_OUT'] as const;
export type EscalationEffect = (typeof ESCALATION_EFFECTS)[number];

export type EffectDiffCategory = 'ESCALATION' | 'NOTE';

export interface EffectChange {
  featureId: string;
  category: EffectDiffCategory;
  added: string[];
  removed: string[];
}

export interface EffectDiff {
  /** Features in current but not in golden. */
  added: string[];
  /** Features in golden but not in current. */
  removed: string[];
  /** Per-feature effect-set change. */
  changed: EffectChange[];
}

/**
 * Compute a categorised diff between golden and current effect surfaces.
 *
 * Output is deterministic: sorted feature IDs, sorted effect arrays.
 */
export function diffEffects(
  golden: ReadonlyMap<string, readonly string[]>,
  current: ReadonlyMap<string, readonly string[]>,
): EffectDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: EffectChange[] = [];

  for (const id of current.keys()) {
    if (!golden.has(id)) added.push(id);
  }
  for (const id of golden.keys()) {
    if (!current.has(id)) removed.push(id);
  }

  for (const id of golden.keys()) {
    const oldE = golden.get(id);
    const newE = current.get(id);
    if (!oldE || !newE) continue;
    const eAdded = setDiff(newE, oldE);
    const eRemoved = setDiff(oldE, newE);
    if (eAdded.length === 0 && eRemoved.length === 0) continue;
    const escalates = eAdded.some((e) => isEscalation(e));
    changed.push({
      featureId: id,
      category: escalates ? 'ESCALATION' : 'NOTE',
      added: eAdded,
      removed: eRemoved,
    });
  }

  added.sort();
  removed.sort();
  changed.sort((a, b) => a.featureId.localeCompare(b.featureId));
  return { added, removed, changed };
}

/** Total number of changes (added + removed features + per-feature changes). */
export function effectDiffSize(diff: EffectDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}

/** Number of ESCALATION-category changes only. */
export function effectEscalationCount(diff: EffectDiff): number {
  return diff.changed.filter((c) => c.category === 'ESCALATION').length;
}

export function formatEffectDiff(diff: EffectDiff): string {
  if (effectDiffSize(diff) === 0) return 'No effect-surface changes vs golden.';
  const lines: string[] = [];
  if (diff.added.length > 0) {
    lines.push(`Added features (${diff.added.length}):`);
    for (const id of diff.added) lines.push(`  + ${id}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`Removed features (${diff.removed.length}):`);
    for (const id of diff.removed) lines.push(`  - ${id}`);
  }
  if (diff.changed.length > 0) {
    lines.push(`Effect-set changes (${diff.changed.length}):`);
    for (const c of diff.changed) {
      const adds = c.added.length ? `+${c.added.join(',')}` : '';
      const rems = c.removed.length ? `-${c.removed.join(',')}` : '';
      lines.push(`  [${c.category}] ${c.featureId}  ${adds} ${rems}`.trimEnd());
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

function isEscalation(effect: string): effect is EscalationEffect {
  return (ESCALATION_EFFECTS as readonly string[]).includes(effect);
}
