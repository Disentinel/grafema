/**
 * Focus / selection transition logic for Canvas interactions.
 *
 * Pure state-transition module — no DOM, no Three.js, no store access.
 * Canvas.tsx (or any other view) builds a FocusIntent from a user event
 * and asks reduceSelection() for the next selection set. The result is
 * then handed to the store via setSelection().
 *
 * This isolation makes the transition rules unit-testable without a
 * browser or a rendering context.
 *
 * Rules:
 *  - click + target=null        → empty selection
 *  - click + target=N           → {N} (replace)
 *  - shiftClick + N ∈ current   → current minus N (deselect)
 *  - shiftClick + N ∉ current   → current plus N (add)
 *  - shiftClick + target=null   → unchanged
 *  - ctrlClick                  → same as shiftClick (additive toggle)
 *  - drag + boxTargets=S        → union(current, S) (marquee adds;
 *                                 shift-drag subtraction intentionally
 *                                 out of scope for this chunk)
 *
 * Invariants:
 *  - reduceSelection() always returns a NEW Set; inputs are never mutated
 *  - Pure: same (current, intent) → same output
 */

export type SelectionSet = ReadonlySet<number>;

export interface FocusIntent {
  /** How the user produced this focus event. */
  kind: 'click' | 'shiftClick' | 'ctrlClick' | 'drag';
  /** Node index that was hit, or null if the user clicked empty space. */
  target: number | null;
  /** For 'drag' (marquee selection): the nodes inside the drag box. */
  boxTargets?: ReadonlySet<number>;
}

/**
 * Given the current selection and a user intent, compute the next selection.
 *
 * Pure function. Does not mutate `current`. Always returns a fresh Set
 * (even for "unchanged" outcomes) so callers can compare references if
 * they want, and so React/zustand consumers see a new identity.
 */
export function reduceSelection(
  current: SelectionSet,
  intent: FocusIntent,
): ReadonlySet<number> {
  switch (intent.kind) {
    case 'click': {
      // Plain click: replace selection. Null target → clear.
      if (intent.target === null) return new Set<number>();
      return new Set<number>([intent.target]);
    }

    case 'shiftClick':
    case 'ctrlClick': {
      // Additive toggle. Null target is a no-op but we still return a
      // fresh Set to preserve the immutability invariant.
      const next = new Set<number>(current);
      if (intent.target === null) return next;
      if (next.has(intent.target)) {
        next.delete(intent.target);
      } else {
        next.add(intent.target);
      }
      return next;
    }

    case 'drag': {
      // Marquee: union with boxTargets. Missing/empty boxTargets → no
      // content change, but still a fresh Set.
      const next = new Set<number>(current);
      if (intent.boxTargets) {
        for (const id of intent.boxTargets) next.add(id);
      }
      return next;
    }
  }
}
