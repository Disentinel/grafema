/**
 * contractDiff — Layer 2 of the regression-test infrastructure (REG-1117).
 *
 * Compares two snapshots of FEATURE → SpecedContractData and produces a
 * categorised diff with per-change severity (BREAKING vs MINOR vs COSMETIC).
 *
 * Severity rules (informed by API-stability convention; see REG-1117 spec):
 *   - Removed input          → BREAKING
 *   - Type of input changed  → BREAKING
 *   - Optional → required    → BREAKING (callers can no longer omit it)
 *   - Reordered POSITIONAL CLI input (no leading "-") → BREAKING
 *   - Added input            → MINOR (additive)
 *   - Required → optional    → MINOR (relaxation)
 *   - Added/removed output   → BREAKING (callers expect specific keys)
 *   - Type of output changed → BREAKING
 *   - Added/removed error    → BREAKING (callers' error-handling assumptions)
 *   - Description changed    → COSMETIC (ignored in diff output)
 *
 * Pure function, no IO, deterministic output ordering.
 */

import type {
  SpecedContractData,
  SpecedContractInput,
  SpecedContractOutput,
  SpecedContractError,
  SpecedContractSource,
} from '../enrichers/specedContractEnricher.js';

export type DiffSeverity = 'BREAKING' | 'MINOR' | 'NOTE' | 'COSMETIC';

export interface ContractDiff {
  /** Features present in current but not in golden. */
  added: string[];
  /** Features present in golden but not in current. */
  removed: string[];
  /** Per-feature change summary. */
  changed: ContractChange[];
}

/** All changes for a single feature, with per-change severity tags. */
export interface ContractChange {
  featureId: string;
  /** Source category (commander, mcp-inputSchema, …). */
  source: SpecedContractSource;
  /** Highest severity across all changes for this feature. */
  severity: DiffSeverity;
  inputs: InputDelta[];
  outputs: OutputDelta[];
  errors: ErrorDelta[];
}

export interface InputDelta {
  kind:
    | 'added'
    | 'removed'
    | 'typeChanged'
    | 'optionalityChanged'
    | 'reordered'
    | 'defaultChanged'
    | 'enumChanged'
    | 'formatChanged';
  name: string;
  severity: DiffSeverity;
  oldType?: string;
  newType?: string;
  oldOptional?: boolean;
  newOptional?: boolean;
  oldPosition?: number;
  newPosition?: number;
  oldDefault?: unknown;
  newDefault?: unknown;
  oldEnum?: unknown[];
  newEnum?: unknown[];
  oldFormat?: string;
  newFormat?: string;
}

export interface OutputDelta {
  kind: 'added' | 'removed' | 'typeChanged';
  name: string;
  severity: DiffSeverity;
  oldType?: string;
  newType?: string;
}

export interface ErrorDelta {
  kind: 'added' | 'removed';
  type: string;
  severity: DiffSeverity;
}

/**
 * Compute a diff for one feature's contract. Returns null if no semantic
 * (non-cosmetic) change. Cosmetic-only changes (description text) intentionally
 * disappear here so they don't pollute regression reports.
 */
function diffOneContract(
  featureId: string,
  oldSpec: SpecedContractData,
  newSpec: SpecedContractData,
  category: string,
): ContractChange | null {
  const inputs: InputDelta[] = [];
  const outputs: OutputDelta[] = [];
  const errors: ErrorDelta[] = [];

  // -- inputs ----------------------------------------------------------------
  const oldInputsByName = indexByName(oldSpec.inputs);
  const newInputsByName = indexByName(newSpec.inputs);

  // Added.
  for (const ni of newSpec.inputs) {
    if (!oldInputsByName.has(ni.name)) {
      inputs.push({ kind: 'added', name: ni.name, severity: 'MINOR', newType: ni.type });
    }
  }
  // Removed + type/optionality change.
  for (const oi of oldSpec.inputs) {
    const ni = newInputsByName.get(oi.name);
    if (!ni) {
      inputs.push({ kind: 'removed', name: oi.name, severity: 'BREAKING', oldType: oi.type });
      continue;
    }
    if ((oi.type ?? '') !== (ni.type ?? '')) {
      inputs.push({
        kind: 'typeChanged',
        name: oi.name,
        severity: 'BREAKING',
        oldType: oi.type,
        newType: ni.type,
      });
    }
    const oOpt = !!oi.optional;
    const nOpt = !!ni.optional;
    if (oOpt !== nOpt) {
      // Optional→required is breaking; required→optional is minor.
      const sev: DiffSeverity = oOpt && !nOpt ? 'BREAKING' : 'MINOR';
      inputs.push({
        kind: 'optionalityChanged',
        name: oi.name,
        severity: sev,
        oldOptional: oOpt,
        newOptional: nOpt,
      });
    }
    // v2: default / enum / format change tracking. Note-severity — they
    // refine behavior but don't break callers' shape contract. Removing a
    // required is still BREAKING; adding a default that flips required to
    // optional shows up via optionalityChanged above.
    if (!sameValue(oi.default, ni.default)) {
      inputs.push({
        kind: 'defaultChanged',
        name: oi.name,
        severity: 'NOTE',
        oldDefault: oi.default,
        newDefault: ni.default,
      });
    }
    if (!sameEnum(oi.enum, ni.enum)) {
      inputs.push({
        kind: 'enumChanged',
        name: oi.name,
        severity: 'NOTE',
        oldEnum: oi.enum,
        newEnum: ni.enum,
      });
    }
    if ((oi.format ?? '') !== (ni.format ?? '')) {
      inputs.push({
        kind: 'formatChanged',
        name: oi.name,
        severity: 'NOTE',
        oldFormat: oi.format,
        newFormat: ni.format,
      });
    }
  }

  // Reorder check: only meaningful for cli:command positional inputs (no
  // leading "-"). For flag-style (-x, --foo) order doesn't matter.
  if (category === 'cli:command') {
    const oldPos = positionalOrder(oldSpec.inputs);
    const newPos = positionalOrder(newSpec.inputs);
    // Compute reorder events for inputs present in both (same name) whose
    // index changed.
    const oldIdx = new Map(oldPos.map((n, i) => [n, i] as const));
    const newIdx = new Map(newPos.map((n, i) => [n, i] as const));
    for (const [name, oi] of oldIdx) {
      const ni = newIdx.get(name);
      if (ni === undefined) continue;
      if (oi !== ni) {
        inputs.push({
          kind: 'reordered',
          name,
          severity: 'BREAKING',
          oldPosition: oi,
          newPosition: ni,
        });
      }
    }
  }

  // -- outputs ---------------------------------------------------------------
  const oldOutByKey = indexOutputs(oldSpec.outputs);
  const newOutByKey = indexOutputs(newSpec.outputs);

  for (const [key, no] of newOutByKey) {
    const oo = oldOutByKey.get(key);
    if (!oo) {
      outputs.push({ kind: 'added', name: key, severity: 'BREAKING', newType: no.type });
      continue;
    }
    if ((oo.type ?? '') !== (no.type ?? '')) {
      outputs.push({
        kind: 'typeChanged',
        name: key,
        severity: 'BREAKING',
        oldType: oo.type,
        newType: no.type,
      });
    }
  }
  for (const [key, oo] of oldOutByKey) {
    if (!newOutByKey.has(key)) {
      outputs.push({ kind: 'removed', name: key, severity: 'BREAKING', oldType: oo.type });
    }
  }

  // -- errors ----------------------------------------------------------------
  const oldErrTypes = new Set(oldSpec.errors.map((e: SpecedContractError) => e.type));
  const newErrTypes = new Set(newSpec.errors.map((e: SpecedContractError) => e.type));
  for (const t of newErrTypes) {
    if (!oldErrTypes.has(t)) errors.push({ kind: 'added', type: t, severity: 'BREAKING' });
  }
  for (const t of oldErrTypes) {
    if (!newErrTypes.has(t)) errors.push({ kind: 'removed', type: t, severity: 'BREAKING' });
  }

  if (inputs.length === 0 && outputs.length === 0 && errors.length === 0) return null;

  // Deterministic ordering.
  inputs.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  outputs.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  errors.sort((a, b) => a.type.localeCompare(b.type) || a.kind.localeCompare(b.kind));

  const severity = highestSeverity([
    ...inputs.map((d) => d.severity),
    ...outputs.map((d) => d.severity),
    ...errors.map((d) => d.severity),
  ]);

  return { featureId, source: newSpec.source, severity, inputs, outputs, errors };
}

/**
 * Compute the full FEATURE-level diff between two contract snapshots.
 *
 * `categoryByFeatureId` lets us know which features are cli:command (reorder
 * detection only fires for those). When unknown, treat as non-cli — reorders
 * are not flagged as breaking.
 */
export function diffContracts(
  golden: ReadonlyMap<string, SpecedContractData>,
  current: ReadonlyMap<string, SpecedContractData>,
  categoryByFeatureId: ReadonlyMap<string, string> = new Map(),
): ContractDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: ContractChange[] = [];

  for (const id of current.keys()) {
    if (!golden.has(id)) added.push(id);
  }
  for (const id of golden.keys()) {
    if (!current.has(id)) removed.push(id);
  }

  for (const id of golden.keys()) {
    const oldS = golden.get(id);
    const newS = current.get(id);
    if (!oldS || !newS) continue;
    const cat = categoryByFeatureId.get(id) ?? '';
    const c = diffOneContract(id, oldS, newS, cat);
    if (c) changed.push(c);
  }

  added.sort();
  removed.sort();
  changed.sort((a, b) => a.featureId.localeCompare(b.featureId));
  return { added, removed, changed };
}

/** Number of changes; useful for CI gates and test assertions. */
export function contractDiffSize(diff: ContractDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}

/** Number of BREAKING-severity changes only. */
export function contractBreakingCount(diff: ContractDiff): number {
  let count = diff.removed.length; // a removed feature is breaking
  for (const c of diff.changed) {
    if (c.severity === 'BREAKING') count++;
  }
  return count;
}

/**
 * Render diff as multi-line human-readable text. BREAKING items are flagged
 * with `[BREAKING]`, MINOR with `[MINOR]`. Description-only changes are
 * filtered upstream and never appear here.
 */
export function formatContractDiff(diff: ContractDiff): string {
  if (contractDiffSize(diff) === 0) return 'No contract changes vs golden.';
  const lines: string[] = [];
  if (diff.added.length > 0) {
    lines.push(`Added features (${diff.added.length}):`);
    for (const id of diff.added) lines.push(`  + [MINOR] ${id}`);
  }
  if (diff.removed.length > 0) {
    lines.push(`Removed features (${diff.removed.length}):`);
    for (const id of diff.removed) lines.push(`  - [BREAKING] ${id}`);
  }
  if (diff.changed.length > 0) {
    lines.push(`Contract changes (${diff.changed.length}):`);
    for (const c of diff.changed) {
      lines.push(`  ~ [${c.severity}] ${c.featureId}  (source=${c.source})`);
      for (const i of c.inputs) {
        lines.push(`      input ${formatInputDelta(i)}`);
      }
      for (const o of c.outputs) {
        lines.push(`      output ${formatOutputDelta(o)}`);
      }
      for (const e of c.errors) {
        lines.push(`      error  [${e.severity}] ${e.kind} ${e.type}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function indexByName(inputs: SpecedContractInput[]): Map<string, SpecedContractInput> {
  const m = new Map<string, SpecedContractInput>();
  for (const i of inputs) m.set(i.name, i);
  return m;
}

/** Index outputs by best available key — `name` if present, else `type`. */
function indexOutputs(outputs: SpecedContractOutput[]): Map<string, SpecedContractOutput> {
  const m = new Map<string, SpecedContractOutput>();
  for (const o of outputs) {
    const key = o.name ?? o.type ?? '';
    if (!key) continue;
    m.set(key, o);
  }
  return m;
}

/**
 * Return the names of positional inputs (no leading dash) in source order.
 * This is the only place we treat input order as semantically significant.
 */
function positionalOrder(inputs: SpecedContractInput[]): string[] {
  const out: string[] = [];
  for (const i of inputs) {
    if (typeof i.name !== 'string') continue;
    if (i.name.startsWith('-')) continue;
    out.push(i.name);
  }
  return out;
}

function highestSeverity(list: DiffSeverity[]): DiffSeverity {
  if (list.includes('BREAKING')) return 'BREAKING';
  if (list.includes('MINOR')) return 'MINOR';
  if (list.includes('NOTE')) return 'NOTE';
  return 'COSMETIC';
}

/** Strict structural equality for `default`-style payloads. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  // Cheap deep-equality for the small JSON-ish shapes we accept.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Treat enum sets as unordered — a permutation is not a change. */
function sameEnum(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  const stringify = (xs: unknown[]) =>
    xs
      .map((x) => {
        try { return JSON.stringify(x); } catch { return String(x); }
      })
      .sort();
  const sa = stringify(a);
  const sb = stringify(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

function formatInputDelta(d: InputDelta): string {
  const sev = `[${d.severity}]`;
  switch (d.kind) {
    case 'added':
      return `${sev} added ${d.name}${d.newType ? `: ${d.newType}` : ''}`;
    case 'removed':
      return `${sev} removed ${d.name}${d.oldType ? `: ${d.oldType}` : ''}`;
    case 'typeChanged':
      return `${sev} type ${d.name}: ${d.oldType ?? '?'} → ${d.newType ?? '?'}`;
    case 'optionalityChanged':
      return `${sev} optional ${d.name}: ${d.oldOptional} → ${d.newOptional}`;
    case 'reordered':
      return `${sev} reorder ${d.name}: pos ${d.oldPosition} → ${d.newPosition}`;
    case 'defaultChanged':
      return `${sev} default ${d.name}: ${stringifySafe(d.oldDefault)} → ${stringifySafe(d.newDefault)}`;
    case 'enumChanged':
      return `${sev} enum ${d.name}: ${stringifySafe(d.oldEnum)} → ${stringifySafe(d.newEnum)}`;
    case 'formatChanged':
      return `${sev} format ${d.name}: ${d.oldFormat ?? '?'} → ${d.newFormat ?? '?'}`;
  }
}

function stringifySafe(v: unknown): string {
  if (v === undefined) return '∅';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatOutputDelta(d: OutputDelta): string {
  const sev = `[${d.severity}]`;
  switch (d.kind) {
    case 'added':
      return `${sev} added ${d.name}${d.newType ? `: ${d.newType}` : ''}`;
    case 'removed':
      return `${sev} removed ${d.name}${d.oldType ? `: ${d.oldType}` : ''}`;
    case 'typeChanged':
      return `${sev} type ${d.name}: ${d.oldType ?? '?'} → ${d.newType ?? '?'}`;
  }
}
