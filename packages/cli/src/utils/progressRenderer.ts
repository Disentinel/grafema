/**
 * ProgressRenderer - Formats and displays analysis progress for CLI.
 *
 * Consumes ProgressInfo events from Orchestrator and renders them as
 * user-friendly progress output with phase tracking, elapsed time,
 * and spinner animation.
 *
 * @example
 * ```typescript
 * const renderer = new ProgressRenderer({ isInteractive: true });
 * orchestrator.run({
 *   onProgress: (info) => renderer.update(info),
 * });
 * console.log(renderer.finish(elapsed));
 * ```
 */

import type { ProgressInfo } from '@grafema/core';

/**
 * Options for creating a ProgressRenderer instance.
 */
export interface ProgressRendererOptions {
  /** Whether output is to a TTY (enables spinner and line overwriting) */
  isInteractive?: boolean;
  /** Minimum milliseconds between display updates (default: 100) */
  throttle?: number;
  /** Custom write function for output (default: process.stdout.write) */
  write?: (text: string) => void;
}

/**
 * ProgressRenderer - Formats and displays analysis progress for CLI.
 *
 * Consumes ProgressInfo events from Orchestrator and renders them as
 * user-friendly progress output with phase tracking, elapsed time,
 * and spinner animation.
 */
export class ProgressRenderer {
  private phases: string[] = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'];
  private currentPhaseIndex: number = -1;
  private currentPhase: string = '';
  private currentPlugin: string = '';
  private message: string = '';
  private totalFiles: number = 0;
  private processedFiles: number = 0;
  private servicesAnalyzed: number = 0;
  private spinnerIndex: number = 0;
  private isInteractive: boolean;
  private startTime: number;
  private lastDisplayTime: number = 0;
  private displayThrottle: number;
  private write: (text: string) => void;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private activePlugins: string[] = [];
  private nodeCount: number = 0;
  private edgeCount: number = 0;

  constructor(options?: ProgressRendererOptions) {
    this.isInteractive = options?.isInteractive ?? process.stdout.isTTY ?? false;
    this.displayThrottle = options?.throttle ?? 100;
    this.startTime = Date.now();
    this.write = options?.write ?? ((text: string) => process.stdout.write(text));
  }

  /**
   * Process a progress event from Orchestrator.
   * Updates internal state and displays formatted output if throttle allows.
   */
  update(info: ProgressInfo): void {
    // Update phase tracking
    if (info.phase && info.phase !== this.currentPhase) {
      this.currentPhase = info.phase;
      const idx = this.phases.indexOf(info.phase);
      if (idx !== -1) {
        this.currentPhaseIndex = idx;
      }
      // Reset phase-specific state
      this.activePlugins = [];
    }

    // Update state from progress info
    if (info.currentPlugin !== undefined) {
      this.currentPlugin = info.currentPlugin;
      // Track active plugins for enrichment/validation display
      if ((this.currentPhase === 'enrichment' || this.currentPhase === 'validation') &&
          info.currentPlugin && !this.activePlugins.includes(info.currentPlugin)) {
        this.activePlugins.push(info.currentPlugin);
      }
    }
    if (info.message !== undefined) {
      this.message = info.message;
    }
    if (info.totalFiles !== undefined) {
      this.totalFiles = info.totalFiles;
    }
    if (info.processedFiles !== undefined) {
      this.processedFiles = info.processedFiles;
    }
    if (info.servicesAnalyzed !== undefined) {
      this.servicesAnalyzed = info.servicesAnalyzed;
    }

    // Update spinner
    this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length;

    // Check throttling
    const now = Date.now();
    if (now - this.lastDisplayTime < this.displayThrottle) {
      return;
    }
    this.lastDisplayTime = now;

    this.display();
  }

  /**
   * Update graph statistics (called separately from progress events).
   * This allows real-time node/edge count updates.
   */
  setStats(nodeCount: number, edgeCount: number): void {
    this.nodeCount = nodeCount;
    this.edgeCount = edgeCount;
  }

  /**
   * Format and display current state to console.
   */
  private display(): void {
    const output = this.formatOutput();

    if (this.isInteractive) {
      // TTY mode: overwrite previous line, pad with spaces to clear old content
      const padded = output.padEnd(80, ' ');
      this.write(`\r${padded}`);
    } else {
      // Non-TTY mode: append newline
      this.write(`${output}\n`);
    }
  }

  private formatOutput(): string {
    if (this.isInteractive) {
      return this.formatInteractive();
    } else {
      return this.formatNonInteractive();
    }
  }

  /**
   * Format elapsed time as human-readable string.
   */
  private formatElapsed(): string {
    const elapsed = (Date.now() - this.startTime) / 1000;
    if (elapsed < 60) {
      return `${elapsed.toFixed(1)}s`;
    }
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    return `${minutes}m${seconds}s`;
  }

  private formatInteractive(): string {
    const spinner = this.spinnerFrames[this.spinnerIndex];
    const elapsed = this.formatElapsed();
    const phaseLabel = this.getPhaseLabel();
    const progress = this.formatPhaseProgress();
    const stats = this.formatStats();

    // Format: ⠋ [3/5] Analysis... 150/4047 modules | 12.5s | 1.2M nodes
    return `${spinner} ${phaseLabel}${progress} | ${elapsed}${stats}`;
  }

  private formatNonInteractive(): string {
    const elapsed = this.formatElapsed();
    return `[${this.currentPhase}] ${this.message || this.formatPhaseProgress()} (${elapsed})`;
  }

  /**
   * Format node/edge counts if available.
   */
  private formatStats(): string {
    if (this.nodeCount === 0 && this.edgeCount === 0) {
      return '';
    }
    const nodes = this.formatNumber(this.nodeCount);
    const edges = this.formatNumber(this.edgeCount);
    return ` | ${nodes} nodes, ${edges} edges`;
  }

  /**
   * Format large numbers with K/M suffix.
   */
  private formatNumber(n: number): string {
    if (n >= 1_000_000) {
      return `${(n / 1_000_000).toFixed(1)}M`;
    }
    if (n >= 1_000) {
      return `${(n / 1_000).toFixed(1)}K`;
    }
    return String(n);
  }

  /**
   * Get formatted phase label with number, e.g., "[3/5] Analysis..."
   */
  private getPhaseLabel(): string {
    const phaseNum = this.currentPhaseIndex + 1;
    const totalPhases = this.phases.length;
    const phaseName = this.currentPhase.charAt(0).toUpperCase() + this.currentPhase.slice(1);
    return `[${phaseNum}/${totalPhases}] ${phaseName}...`;
  }

  /**
   * Format progress details based on current phase.
   */
  private formatPhaseProgress(): string {
    switch (this.currentPhase) {
      case 'discovery':
        if (this.servicesAnalyzed > 0) {
          return ` ${this.servicesAnalyzed} services found`;
        }
        return '';
      case 'indexing':
      case 'analysis':
        if (this.totalFiles > 0) {
          return ` ${this.processedFiles}/${this.totalFiles} modules`;
        }
        return '';
      case 'enrichment':
      case 'validation':
        if (this.activePlugins.length > 0) {
          return ` (${this.formatPluginList(this.activePlugins)})`;
        }
        return '';
      default:
        return '';
    }
  }

  /**
   * Format plugin list, truncating if more than 3 plugins.
   */
  private formatPluginList(plugins: string[]): string {
    if (plugins.length <= 3) {
      return plugins.join(', ');
    }
    // Truncate to 3 plugins + "..."
    return plugins.slice(0, 3).join(', ') + ', ...';
  }

  /**
   * Get final summary message after analysis complete.
   * @param durationSeconds - Total duration of analysis
   * @returns Formatted completion message
   */
  finish(durationSeconds: number): string {
    return `Analysis complete in ${durationSeconds.toFixed(2)}s`;
  }

  /**
   * Expose internal state for testing.
   * @internal
   */
  getState(): {
    phaseIndex: number;
    phase: string;
    processedFiles: number;
    totalFiles: number;
    servicesAnalyzed: number;
    spinnerIndex: number;
    activePlugins: string[];
    nodeCount: number;
    edgeCount: number;
  } {
    return {
      phaseIndex: this.currentPhaseIndex,
      phase: this.currentPhase,
      processedFiles: this.processedFiles,
      totalFiles: this.totalFiles,
      servicesAnalyzed: this.servicesAnalyzed,
      spinnerIndex: this.spinnerIndex,
      activePlugins: [...this.activePlugins],
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
    };
  }
}
