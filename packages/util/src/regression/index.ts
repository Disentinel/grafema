/**
 * Regression-test helpers (REG-1117).
 *
 * Three layers of pure diff logic over snapshots of the FEATURE → BEHAVIOR /
 * SPECED_CONTRACT / effect-set projections. Used by the golden-file-based
 * regression tests under `test/unit/{behaviorGolden,contractDiff,
 * crossModalityEquivalence,effectSurfaceDiff}.test.js`.
 */

export {
  diffBehaviors,
  behaviorDiffSize,
  formatBehaviorDiff,
} from './behaviorDiff.js';
export type {
  BehaviorMeta,
  BehaviorDiff,
  BehaviorHashChange,
  BehaviorEffectsChange,
} from './behaviorDiff.js';

export {
  diffContracts,
  contractDiffSize,
  contractBreakingCount,
  formatContractDiff,
} from './contractDiff.js';
export type {
  ContractDiff,
  ContractChange,
  InputDelta,
  OutputDelta,
  ErrorDelta,
  DiffSeverity,
} from './contractDiff.js';

export {
  diffEffects,
  effectDiffSize,
  effectEscalationCount,
  formatEffectDiff,
  ESCALATION_EFFECTS,
} from './effectDiff.js';
export type {
  EffectDiff,
  EffectChange,
  EffectDiffCategory,
  EscalationEffect,
} from './effectDiff.js';
