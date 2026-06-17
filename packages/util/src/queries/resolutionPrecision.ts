/**
 * Resolution-precision / ambiguity MARKER (RFD R1, spike).
 *
 * The load-bearing primitive of the resolution-precision RFD: a util-layer
 * classification of each *resolution edge* (a CALLS / CALLS_REMOTE edge whose
 * target is the resolved callee) into one of three soundness classes, derived
 * from EXISTING local graph signals only — no rust/.dl changes, no SCIP, no
 * #431 allowlist:
 *
 *   precise            — exactly one resolved target AND the resolution carries
 *                        a basis that names a single concrete callee with no
 *                        receiver ambiguity (a local same-file/cross-file call,
 *                        a genuine ecma-global whose receiver is preserved, a
 *                        builtin external function).
 *   heuristic-superset — MORE THAN ONE candidate target for the same call (the
 *                        sound-superset case: the real target is in the set, but
 *                        the resolver could not pick one), OR a resolvedVia tag
 *                        known to over-approximate (e.g. rust-cross-method:
 *                        receiver type unknown → every method of that name).
 *                        Acceptable-but-noisy.
 *   suspected-unsound  — a SINGLE target that is provably WRONG: the
 *                        importedDefault.method() → ecma-GLOBAL::method pattern.
 *                        The receiver was stripped by suffix-collapse in
 *                        js_runtime_globals_edges.dl, so `axios.get` resolves to
 *                        the ecma-global `GLOBAL::get` (PURE) even though `axios`
 *                        is a real non-relative import. This passes the ≤1-target
 *                        "is-a-function" guarantee while presenting the WRONG
 *                        single callee. A defect that must be hard-flagged.
 *
 * The classification is a per-edge ATTRIBUTE the graph never carried before
 * (greenfield — grep over packages/util/src found no existing
 * precision/confidence/superset marker on edges). Everything else in the RFD
 * (R2 surfacing, R3 upsell, R4 invariant, R5 detector) consumes this.
 *
 * Cheap + local: the classifier itself is pure over signals already on the
 * edge/target; the suspected-unsound test reuses the exact receiver-resolution
 * walk that traceEffects.resolveReceiverModule already performs.
 *
 * @module queries/resolutionPrecision
 */

import type { DataflowBackend, DataflowNode, DataflowEdge } from './traceDataflow.js';

// ── Marker schema ─────────────────────────────────────────────

export type ResolutionPrecision = 'precise' | 'heuristic-superset' | 'suspected-unsound';

/**
 * The marker carried on (conceptually) a resolution edge. In this spike it is
 * computed on demand by the classifier/audit rather than persisted — the
 * attribute SHAPE is the contract R2..R5 consume; where it is physically stored
 * (edge metadata column vs. derived-on-read) is a downstream decision.
 */
export interface ResolutionMarker {
  /** Soundness class. */
  precision: ResolutionPrecision;
  /**
   * Number of resolved targets for this (source CALL, edge-type) — the fan-out.
   * 1 for precise / suspected-unsound; ≥2 for heuristic-superset.
   */
  candidateCount: number;
  /**
   * Why this class was assigned. Names the EXISTING signal it was derived from,
   * so the marker is auditable and the team-server upsell (R3) can quote it.
   */
  basis: ResolutionBasis;
  /** The resolvedVia provenance tag on the edge, if any (verbatim). */
  resolvedVia?: string;
}

export type ResolutionBasis =
  /** Single concrete callee, no receiver ambiguity. */
  | 'single-concrete-target'
  /** >1 candidate for the same call: real target present but not disambiguated. */
  | 'multiple-candidates'
  /** resolvedVia tag known to over-approximate without a local type clue. */
  | 'type-unaware-method-superset'
  /** importedDefault.method() collapsed to an ecma-GLOBAL::method (wrong single target). */
  | 'imported-default-method-to-ecma-global';

// ── Signals ───────────────────────────────────────────────────

/** Edge types that carry a "resolved callee" relation we classify. */
const RESOLUTION_EDGE_TYPES = ['CALLS', 'CALLS_REMOTE'];

/**
 * resolvedVia tags that, per the resolver design, produce a sound SUPERSET when
 * no local type clue is available — the resolver emits every method of that
 * name. (rust-cross-method: receiver type unknown ⇒ all same-named methods.)
 */
const SUPERSET_RESOLVED_VIA = new Set(['rust-cross-method']);

/** resolvedVia tags whose targets are ecma-globals (suffix-collapse risk). */
const ECMA_GLOBAL_RESOLVED_VIA = new Set(['runtime-globals']);

// ── Per-edge classifier (pure) ────────────────────────────────

export interface ClassifyContext {
  /** The originating CALL node. */
  call: DataflowNode;
  /** The single resolution edge being classified. */
  edge: DataflowEdge;
  /** The resolved target node. */
  target: DataflowNode | null;
  /** Total number of resolution-edge targets for this call (fan-out). */
  candidateCount: number;
  /**
   * True iff the call's receiver resolves to a NON-RELATIVE import binding
   * (the importedDefault.method() precondition). Computed by the caller via
   * the receiver walk so the classifier stays pure/synchronous.
   */
  receiverIsExternalImport: boolean;
}

/**
 * Classify one resolution edge. Pure: all async graph reads are done by the
 * caller and fed in via ClassifyContext.
 *
 * Order of tests (most-specific defect first):
 *  1. suspected-unsound — importedDefault.method() → ecma GLOBAL::method.
 *  2. heuristic-superset — fan-out > 1, OR a type-unaware-method resolvedVia.
 *  3. precise — otherwise.
 */
export function classifyResolution(ctx: ClassifyContext): ResolutionMarker {
  const meta = (ctx.edge.metadata ?? {}) as Record<string, unknown>;
  const resolvedVia = typeof meta.resolvedVia === 'string' ? meta.resolvedVia : undefined;

  // (1) suspected-unsound: the axios.get → GLOBAL::get defect.
  //
  // Signature, all derivable locally:
  //   - target is an ecma GLOBAL_DEFINITION reached via runtime-globals;
  //   - the CALL name is dotted (receiver.method) but the target name is only
  //     the method suffix → the receiver was collapsed away;
  //   - the receiver resolves to a NON-RELATIVE import binding → it is a real
  //     external package, NOT a genuine ecma-global (JSON / Math / globalThis).
  if (
    ctx.target?.type === 'GLOBAL_DEFINITION' &&
    resolvedVia !== undefined &&
    ECMA_GLOBAL_RESOLVED_VIA.has(resolvedVia) &&
    ctx.receiverIsExternalImport &&
    isReceiverCollapsed(ctx.call, ctx.target)
  ) {
    return {
      precision: 'suspected-unsound',
      candidateCount: ctx.candidateCount,
      basis: 'imported-default-method-to-ecma-global',
      resolvedVia,
    };
  }

  // (2) heuristic-superset.
  if (ctx.candidateCount > 1) {
    return {
      precision: 'heuristic-superset',
      candidateCount: ctx.candidateCount,
      basis: 'multiple-candidates',
      resolvedVia,
    };
  }
  if (resolvedVia !== undefined && SUPERSET_RESOLVED_VIA.has(resolvedVia)) {
    return {
      precision: 'heuristic-superset',
      candidateCount: ctx.candidateCount,
      basis: 'type-unaware-method-superset',
      resolvedVia,
    };
  }

  // (3) precise.
  return {
    precision: 'precise',
    candidateCount: ctx.candidateCount,
    basis: 'single-concrete-target',
    resolvedVia,
  };
}

/**
 * True iff the CALL name is dotted (`receiver.method`) but the resolved target
 * name is ONLY the trailing method segment — i.e. the receiver was stripped by
 * suffix-collapse. Distinguishes the axios.get→GLOBAL::get defect (call
 * "axios.get", target "get") from a genuine ecma-global (JSON.parse→
 * GLOBAL::JSON.parse, where call "JSON.parse" == target "JSON.parse",
 * receiver preserved).
 */
function isReceiverCollapsed(call: DataflowNode, target: DataflowNode): boolean {
  const callName = typeof call.name === 'string' ? call.name : '';
  const targetName = typeof target.name === 'string' ? target.name : '';
  const dot = callName.lastIndexOf('.');
  if (dot < 0) return false; // call name not dotted → no receiver to collapse
  const suffix = callName.slice(dot + 1);
  // Collapsed: target carries only the suffix, not the full dotted callName.
  return targetName === suffix && targetName !== callName;
}

// ── Receiver walk (R5 precondition) ───────────────────────────
//
// Mirrors traceEffects.resolveReceiverModule: does the CALL's receiver resolve
// to a NON-RELATIVE import binding? We return the module specifier (truthy) or
// null. Kept here so the marker is self-contained for the spike; the production
// merge would share the one copy in traceEffects.

export async function receiverExternalImport(
  backend: DataflowBackend,
  callId: string,
): Promise<string | null> {
  const derivesFrom = await backend.getOutgoingEdges(callId, ['DERIVES_FROM']);
  for (const df of derivesFrom) {
    const pa = await backend.getNode(df.dst);
    if (!pa || pa.type !== 'PROPERTY_ACCESS') continue;
    const readsFrom = await backend.getOutgoingEdges(pa.id, ['READS_FROM']);
    for (const rf of readsFrom) {
      const ref = await backend.getNode(rf.dst);
      if (!ref) continue;
      const direct = importBindingSource(ref);
      if (direct) return direct;
      if (ref.type === 'REFERENCE') {
        const rf2s = await backend.getOutgoingEdges(ref.id, ['READS_FROM']);
        for (const rf2 of rf2s) {
          const binding = await backend.getNode(rf2.dst);
          const src = binding ? importBindingSource(binding) : null;
          if (src) return src;
        }
      }
    }
  }
  return null;
}

function importBindingSource(node: DataflowNode): string | null {
  if (node.type !== 'IMPORT_BINDING') return null;
  const source = (node as Record<string, unknown>).source;
  if (typeof source !== 'string' || source.length === 0) return null;
  if (source.startsWith('.') || source.startsWith('/')) return null;
  return source;
}

// ── POC: graph-wide audit ─────────────────────────────────────

export interface MarkedResolution {
  callId: string;
  callName: string;
  targetId: string;
  targetName: string;
  targetType: string;
  edgeType: string;
  marker: ResolutionMarker;
}

export interface UnsoundCase {
  callId: string;
  /** e.g. "axios.get" */
  callName: string;
  /** The (wrong) resolved ecma-global, e.g. "GLOBAL::get". */
  resolvedTo: string;
  /** The collapsed-away receiver's module specifier, e.g. "axios". */
  receiverModule: string;
  /** Effects the wrong global presents (e.g. ["PURE"]) — what the defect masks. */
  presentedEffects: string[];
}

export interface ResolutionPrecisionAudit {
  /** Every resolution edge with its marker. */
  resolutions: MarkedResolution[];
  /** Tally by precision class. */
  counts: Record<ResolutionPrecision, number>;
  /** The suspected-unsound importedDefault.method()→ecma-global cases. */
  suspectedUnsound: UnsoundCase[];
}

/**
 * Walk the graph: classify every CALLS / CALLS_REMOTE resolution edge and
 * collect the suspected-unsound importedDefault.method()→ecma-global cases.
 *
 * Works against any DataflowBackend (RFDBServerBackend on a live socket, or an
 * in-memory fixture backend for unit tests).
 */
export async function auditResolutionPrecision(
  backend: DataflowBackend,
): Promise<ResolutionPrecisionAudit> {
  const calls: DataflowNode[] = [];
  for await (const n of backend.queryNodes({ type: 'CALL' })) calls.push(n);

  const resolutions: MarkedResolution[] = [];
  const counts: Record<ResolutionPrecision, number> = {
    precise: 0,
    'heuristic-superset': 0,
    'suspected-unsound': 0,
  };
  const suspectedUnsound: UnsoundCase[] = [];

  for (const call of calls) {
    const edges = await backend.getOutgoingEdges(call.id, RESOLUTION_EDGE_TYPES);
    if (edges.length === 0) continue;
    const candidateCount = edges.length;

    // Receiver walk done once per call (independent of the per-edge target).
    const receiverModule = await receiverExternalImport(backend, call.id);
    const receiverIsExternalImport = receiverModule !== null;

    for (const edge of edges) {
      const target = await backend.getNode(edge.dst);
      const marker = classifyResolution({
        call,
        edge,
        target,
        candidateCount,
        receiverIsExternalImport,
      });
      counts[marker.precision] += 1;
      resolutions.push({
        callId: call.id,
        callName: typeof call.name === 'string' ? call.name : '',
        targetId: edge.dst,
        targetName: typeof target?.name === 'string' ? target.name : '',
        targetType: target?.type ?? '<missing>',
        edgeType: edge.type,
        marker,
      });

      if (marker.precision === 'suspected-unsound') {
        suspectedUnsound.push({
          callId: call.id,
          callName: typeof call.name === 'string' ? call.name : '',
          resolvedTo: edge.dst,
          receiverModule: receiverModule as string,
          presentedEffects: readEffects(target),
        });
      }
    }
  }

  return { resolutions, counts, suspectedUnsound };
}

/** Read a target's effects in either array or comma-string shape. */
function readEffects(node: DataflowNode | null): string[] {
  if (!node) return [];
  const raw = (node as Record<string, unknown>).effects;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.length > 0) {
    return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
  }
  return [];
}

// ── R4: soundness taxonomy + util-layer invariant check ───────
//
// The three precision classes carry a SOUNDNESS verdict the ≤1-target
// "is-a-function" guarantee cannot express:
//
//   precise            → SOUND   (the resolution names the one real callee).
//   heuristic-superset → SOUND   (acceptable-but-noisy: the real target IS in
//                                 the candidate set; the resolver over-
//                                 approximated but dropped nothing).
//   suspected-unsound  → UNSOUND (a DEFECT: the real target was dropped and a
//                                 single WRONG callee presented in its place —
//                                 axios.get → ecma GLOBAL::get. This passes the
//                                 ≤1-target guarantee while lying about the
//                                 callee, so it needs an explicit hard flag).
//
// `checkResolutionSoundness` is the explicit hard-flag: given a backend it
// returns every unsound resolution as a VIOLATION. It is a plain function
// (NOT a guarantees.yaml rule — that surface is vm-owned), so the unsound
// class is caught at the util layer even though it survives the structural
// guarantee.

/** Soundness verdict for a precision class (R4 taxonomy). */
export type SoundnessVerdict = 'sound' | 'sound-superset' | 'unsound';

/** Map a precision class to its soundness verdict. */
export function soundnessOf(precision: ResolutionPrecision): SoundnessVerdict {
  switch (precision) {
    case 'precise':
      return 'sound';
    case 'heuristic-superset':
      return 'sound-superset';
    case 'suspected-unsound':
      return 'unsound';
  }
}

/** A single unsound resolution surfaced as a hard violation. */
export interface ResolutionSoundnessViolation {
  callId: string;
  callName: string;
  /** The (wrong) single resolved target. */
  resolvedTo: string;
  resolvedToName: string;
  /** The collapsed-away receiver's module specifier (e.g. "axios"). */
  receiverModule: string;
  /** Effects the wrong target masks (e.g. ["PURE"]). */
  presentedEffects: string[];
  basis: ResolutionBasis;
  /** Always 'unsound' here — kept explicit so callers can branch on verdict. */
  verdict: SoundnessVerdict;
}

export interface ResolutionSoundnessReport {
  /** True iff at least one unsound resolution was found. */
  hasUnsound: boolean;
  /** Every unsound resolution as a hard violation. */
  violations: ResolutionSoundnessViolation[];
  /** Tally by soundness verdict across all resolution edges. */
  bySoundness: Record<SoundnessVerdict, number>;
}

/**
 * R4 invariant check: flag every UNSOUND resolution (suspected-unsound class)
 * as a hard violation. Sound and sound-superset resolutions are tallied but
 * never reported as violations.
 *
 * This is the util-layer counterpart to the ≤1-target "is-a-function"
 * guarantee: that guarantee passes on the axios.get→GLOBAL::get defect (it IS
 * one function); THIS check fails it.
 */
export async function checkResolutionSoundness(
  backend: DataflowBackend,
): Promise<ResolutionSoundnessReport> {
  const audit = await auditResolutionPrecision(backend);

  const bySoundness: Record<SoundnessVerdict, number> = {
    sound: 0,
    'sound-superset': 0,
    unsound: 0,
  };
  for (const r of audit.resolutions) {
    bySoundness[soundnessOf(r.marker.precision)] += 1;
  }

  const violations: ResolutionSoundnessViolation[] = [];
  for (const r of audit.resolutions) {
    if (r.marker.precision !== 'suspected-unsound') continue;
    const u = audit.suspectedUnsound.find(c => c.callId === r.callId && c.resolvedTo === r.targetId);
    violations.push({
      callId: r.callId,
      callName: r.callName,
      resolvedTo: r.targetId,
      resolvedToName: r.targetName,
      receiverModule: u?.receiverModule ?? '',
      presentedEffects: u?.presentedEffects ?? [],
      basis: r.marker.basis,
      verdict: 'unsound',
    });
  }

  return { hasUnsound: violations.length > 0, violations, bySoundness };
}
