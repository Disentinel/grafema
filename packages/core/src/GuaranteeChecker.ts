/**
 * GuaranteeChecker — runs guarantee checks after enrichment, before validation.
 * Extracted from Orchestrator.ts (REG-462).
 *
 * Responsibilities:
 * - Load and execute guarantees via GuaranteeManager (RFD-18)
 * - Selective vs full checking based on enrichment delta
 * - Collect violations into diagnostics
 * - Coverage monitoring canary
 */

import type { GraphBackend, Logger } from '@grafema/types';
import type { DiagnosticCollector } from './diagnostics/DiagnosticCollector.js';
import type { Profiler } from './core/Profiler.js';
import type { ProgressCallback } from './PhaseRunner.js';

export class GuaranteeChecker {
  constructor(
    private graph: GraphBackend,
    private diagnosticCollector: DiagnosticCollector,
    private profiler: Profiler,
    private onProgress: ProgressCallback,
    private logger: Logger,
  ) {}

  /**
   * Run guarantee checks after enrichment (RFD-18).
   * Uses selective checking when enrichment produced type changes,
   * falls back to checkAll when no type info is available.
   */
  async check(changedTypes: Set<string>, projectPath: string): Promise<void> {
    const { GuaranteeManager } = await import('./core/GuaranteeManager.js');

    const manager = new GuaranteeManager(this.graph as any, projectPath);
    const guarantees = await manager.list();

    if (guarantees.length === 0) {
      this.logger.debug('No guarantees to check');
      this.checkCoverageGaps(changedTypes);
      return;
    }

    const startTime = Date.now();
    this.profiler.start('GUARANTEE_CHECK');
    this.onProgress({ phase: 'guarantee', currentPlugin: 'GuaranteeCheck', message: 'Checking guarantees...' });

    const result = changedTypes.size > 0
      ? await manager.checkSelective(changedTypes)
      : await manager.checkAll();

    // Collect violations into diagnostics
    for (const r of result.results) {
      if (!r.passed && !r.error) {
        for (const violation of r.violations) {
          this.diagnosticCollector.add({
            code: 'GUARANTEE_VIOLATION',
            severity: r.severity === 'error' ? 'fatal' : 'warning',
            message: `Guarantee "${r.name}" violated: ${violation.type} ${violation.name || violation.nodeId}`,
            phase: 'ENRICHMENT',
            plugin: 'GuaranteeCheck',
            file: violation.file,
            line: violation.line,
          });
        }
      }
    }

    this.profiler.end('GUARANTEE_CHECK');
    this.logger.info('GUARANTEE_CHECK complete', {
      duration: ((Date.now() - startTime) / 1000).toFixed(2),
      total: result.total,
      checked: result.results.length,
      passed: result.passed,
      failed: result.failed,
    });

    this.checkCoverageGaps(changedTypes);
  }

  /**
   * Coverage monitoring canary (RFD-18).
   * Logs a warning if enrichment produced no type changes at all,
   * which may indicate a coverage gap.
   */
  private checkCoverageGaps(changedTypes: Set<string>): void {
    if (changedTypes.size === 0) {
      this.logger.debug('Coverage canary: enrichment produced no type changes');
    }
  }
}
