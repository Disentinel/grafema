// oracle.ts — the vendored ROFL v0 engine wrapped in the same duck-typed
// surface the RfdbRofl adapter exposes, so every tier-1 scenario runs
// UNCHANGED against oracle (self-check pass) and subject (verdict pass).

import * as path from 'node:path';
import { Rofl } from '../vendor/rofl-v0/src/api.ts';
import type { Clause } from './neutral.ts';
import { checkKernelVocabulary } from '../vendor/rofl-v0/scripts/kernel_grep.ts';
import { v0FactSet } from './canonical.ts';

export const VENDOR_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../vendor/rofl-v0');

export class OracleEngine {
  r: Rofl;

  constructor(opts: { naive?: boolean } = {}) {
    this.r = new Rofl(opts);
  }

  static fromSnapshot(json: string, opts: { naive?: boolean } = {}): OracleEngine {
    const e = Object.create(OracleEngine.prototype) as OracleEngine;
    e.r = Rofl.fromSnapshot(json, opts);
    return e;
  }

  load(text: string, opts: { who?: string; budget?: number } = {}): { ok: boolean; diagnostics: string[] } {
    return this.r.load(text, opts);
  }
  assert(text: string, opts: { who?: string } = {}): { ok: boolean; diagnostics: string[] } {
    return this.r.assert(text, opts);
  }
  assertClauses(clauses: Clause[], opts: { who?: string } = {}): { ok: boolean; diagnostics: string[] } {
    return this.r.assertClauses(clauses, opts);
  }
  retract(text: string): { ok: boolean; diagnostics: string[] } {
    return this.r.retract(text);
  }
  evaluate(budget?: number): { partial: boolean } {
    return this.r.evaluate(budget);
  }
  query(text: string, opts: { budget?: number } = {}): { rows: { text: string; bindings: Record<string, string> }[]; partial: boolean; error?: string } {
    return this.r.query(text, opts);
  }
  holds(text: string): boolean {
    return this.r.holds(text);
  }
  why(text: string, opts: { budget?: number } = {}): { ok: boolean; text: string } {
    return this.r.why(text, opts);
  }
  whynot(text: string, opts: { budget?: number } = {}): { holds: boolean; text: string } {
    return this.r.whynot(text, opts);
  }
  excise(text: string, opts: { budget?: number } = {}): { ok: boolean; removed: string[]; added: string[]; error?: string } {
    return this.r.excise(text, opts);
  }
  tickAdvance(opts: { budget?: number; onFixpoint?: (e: OracleEngine) => void } = {}): { advanced: boolean; quiescent: boolean; partial: boolean } {
    return this.r.tickAdvance({ budget: opts.budget, onFixpoint: opts.onFixpoint ? () => opts.onFixpoint!(this) : undefined });
  }
  run(opts: { maxTicks?: number; budget?: number; onBoundary?: (e: OracleEngine) => void } = {}): { ticks: number; quiescent: boolean; partial: boolean } {
    return this.r.run({ maxTicks: opts.maxTicks, budget: opts.budget, onBoundary: opts.onBoundary ? () => opts.onBoundary!(this) : undefined });
  }
  save(): string {
    return this.r.save();
  }
  canonicalState(): string {
    return this.r.store.canonicalState();
  }
  factKeys(rel?: string): string[] {
    return this.r.factKeys(rel);
  }
  strataPlan(): { rule: string; rel: string; level: number | null }[] {
    return this.r.strataPlan();
  }
  supportCount(key: string): number {
    return this.r.store.supportCount(key);
  }
  kernelVocabularyCheck(): { file: string; line: number; what: string }[] {
    return checkKernelVocabulary(VENDOR_ROOT);
  }
  domainFactSet(): string[] {
    return v0FactSet(this.r);
  }
}
