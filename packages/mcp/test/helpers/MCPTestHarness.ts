/**
 * Test harness for MCP handlers
 *
 * Allows injecting mock backend and state for isolated tests.
 *
 * Key features:
 * - Tracks `analysisCallLog` for verifying serialization
 * - `simulateAnalysis()` method with configurable delay
 * - `getAnalysisStatus()` method for status checks
 */

import { MockBackend, type MockBackendOptions } from './MockBackend.js';

export interface HarnessOptions extends MockBackendOptions {
  projectPath?: string;
  isAnalyzed?: boolean;
}

interface AnalysisCallEntry {
  startTime: number;
  endTime?: number;
  service?: string;
  force?: boolean;
}

export class MCPTestHarness {
  public backend: MockBackend;
  public projectPath: string;
  public isAnalyzed: boolean;

  // Track analysis calls for concurrency tests
  public analysisCallLog: AnalysisCallEntry[] = [];

  constructor(options: HarnessOptions = {}) {
    this.backend = new MockBackend(options);
    this.projectPath = options.projectPath ?? '/test/project';
    this.isAnalyzed = options.isAnalyzed ?? false;
  }

  /**
   * Reset state between tests
   */
  reset(): void {
    this.isAnalyzed = false;
    this.analysisCallLog = [];
    this.backend.clearCalled = false;
    this.backend.clearCallCount = 0;
  }

  /**
   * Get mock analysis status
   */
  getAnalysisStatus(): {
    running: boolean;
    phase: string | null;
    message: string | null;
    servicesDiscovered: number;
    servicesAnalyzed: number;
    startTime: number | null;
    endTime: number | null;
    error: string | null;
    timings: { total: number | null };
  } {
    const running = this.analysisCallLog.some(c => !c.endTime);
    return {
      running,
      phase: running ? 'analysis' : null,
      message: null,
      servicesDiscovered: 0,
      servicesAnalyzed: 0,
      startTime: null,
      endTime: null,
      error: null,
      timings: { total: null },
    };
  }

  /**
   * Simulate analysis (with configurable delay)
   */
  async simulateAnalysis(service?: string, force?: boolean): Promise<void> {
    const callEntry: AnalysisCallEntry = {
      startTime: Date.now(),
      service,
      force,
    };
    this.analysisCallLog.push(callEntry);

    if (force) {
      await this.backend.clear();
    }

    // Simulate analysis time
    if (this.backend.analysisDelay > 0) {
      await new Promise(r => setTimeout(r, this.backend.analysisDelay));
    }

    // Add some nodes
    await this.backend.addNode({ id: 'MODULE:test', type: 'MODULE', name: 'test' });

    callEntry.endTime = Date.now();
    this.isAnalyzed = true;
  }
}
