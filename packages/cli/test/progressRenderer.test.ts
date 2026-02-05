/**
 * Tests for ProgressRenderer - REG-350
 *
 * Tests the CLI progress display formatting:
 * - Phase transitions and indexing
 * - Progress accumulation (processedFiles, servicesAnalyzed)
 * - TTY vs non-TTY output modes
 * - Display throttling
 * - Output format accuracy for each phase
 * - Spinner animation
 * - Plugin list formatting
 * - Final summary message
 *
 * Based on spec: _tasks/REG-350/003-joel-tech-plan.md
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ProgressRenderer } from '../src/utils/progressRenderer.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Helper to capture output for testing.
 */
class OutputCapture {
  public lines: string[] = [];

  write = (text: string): void => {
    this.lines.push(text);
  };

  clear(): void {
    this.lines = [];
  }

  getLastLine(): string {
    return this.lines[this.lines.length - 1] ?? '';
  }

  getAllOutput(): string {
    return this.lines.join('');
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe('ProgressRenderer', () => {
  let output: OutputCapture;
  let renderer: ProgressRenderer;

  beforeEach(() => {
    output = new OutputCapture();
  });

  // ===========================================================================
  // TEST 1: Phase transitions
  // ===========================================================================

  describe('phase transitions', () => {
    it('should update phase index when phase changes', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery' });
      assert.strictEqual(renderer.getState().phaseIndex, 0, 'discovery should be index 0');
      assert.strictEqual(renderer.getState().phase, 'discovery');

      renderer.update({ phase: 'indexing' });
      assert.strictEqual(renderer.getState().phaseIndex, 1, 'indexing should be index 1');
      assert.strictEqual(renderer.getState().phase, 'indexing');

      renderer.update({ phase: 'analysis' });
      assert.strictEqual(renderer.getState().phaseIndex, 2, 'analysis should be index 2');

      renderer.update({ phase: 'enrichment' });
      assert.strictEqual(renderer.getState().phaseIndex, 3, 'enrichment should be index 3');

      renderer.update({ phase: 'validation' });
      assert.strictEqual(renderer.getState().phaseIndex, 4, 'validation should be index 4');
    });

    it('should handle unknown phase gracefully', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'unknown-phase' });
      // Should not crash, phase index stays at -1
      assert.strictEqual(renderer.getState().phaseIndex, -1, 'unknown phase should have index -1');
      assert.strictEqual(renderer.getState().phase, 'unknown-phase');
    });

    it('should show phase number in output format [X/5]', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'analysis' });
      const lastOutput = output.getLastLine();
      assert.ok(lastOutput.includes('[3/5]'), `Should show [3/5] for analysis. Got: ${lastOutput}`);
    });
  });

  // ===========================================================================
  // TEST 2: Progress accumulation
  // ===========================================================================

  describe('progress accumulation', () => {
    it('should track processedFiles and totalFiles', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'indexing', totalFiles: 100, processedFiles: 0 });
      assert.strictEqual(renderer.getState().totalFiles, 100);
      assert.strictEqual(renderer.getState().processedFiles, 0);

      renderer.update({ phase: 'indexing', processedFiles: 50 });
      assert.strictEqual(renderer.getState().processedFiles, 50);

      renderer.update({ phase: 'indexing', processedFiles: 100 });
      assert.strictEqual(renderer.getState().processedFiles, 100);
    });

    it('should display processedFiles/totalFiles in output', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'indexing', totalFiles: 4047, processedFiles: 2150 });
      const lastOutput = output.getLastLine();
      assert.ok(
        lastOutput.includes('2150/4047'),
        `Should show 2150/4047 modules. Got: ${lastOutput}`
      );
    });

    it('should track servicesAnalyzed for discovery phase', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery', servicesAnalyzed: 0 });
      assert.strictEqual(renderer.getState().servicesAnalyzed, 0);

      renderer.update({ phase: 'discovery', servicesAnalyzed: 12 });
      assert.strictEqual(renderer.getState().servicesAnalyzed, 12);
    });

    it('should display services count in discovery phase', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery', servicesAnalyzed: 12 });
      const lastOutput = output.getLastLine();
      assert.ok(
        lastOutput.includes('12 services'),
        `Should show 12 services found. Got: ${lastOutput}`
      );
    });
  });

  // ===========================================================================
  // TEST 3: TTY detection
  // ===========================================================================

  describe('TTY detection', () => {
    it('should respect isInteractive option = true', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery' });
      const lastOutput = output.getLastLine();

      // TTY mode uses carriage return prefix for line overwriting
      assert.ok(
        lastOutput.startsWith('\r'),
        `TTY mode should start with \\r. Got: ${JSON.stringify(lastOutput)}`
      );
      // TTY mode should NOT end with newline
      assert.ok(
        !lastOutput.endsWith('\n'),
        'TTY mode should not end with newline'
      );
    });

    it('should respect isInteractive option = false', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery' });
      const lastOutput = output.getLastLine();

      // Non-TTY mode should NOT have carriage return
      assert.ok(
        !lastOutput.startsWith('\r'),
        `Non-TTY mode should not start with \\r. Got: ${JSON.stringify(lastOutput)}`
      );
      // Non-TTY mode should end with newline
      assert.ok(
        lastOutput.endsWith('\n'),
        'Non-TTY mode should end with newline'
      );
    });

    it('should show spinner in interactive mode', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery' });
      const lastOutput = output.getLastLine();

      // Should contain a spinner character (Braille pattern)
      const hasSpinner = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(lastOutput);
      assert.ok(hasSpinner, `Interactive mode should show spinner. Got: ${lastOutput}`);
    });

    it('should show [phase] prefix in non-interactive mode', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery', message: 'Finding services...' });
      const lastOutput = output.getLastLine();

      assert.ok(
        lastOutput.includes('[discovery]'),
        `Non-interactive should show [phase] prefix. Got: ${lastOutput}`
      );
    });
  });

  // ===========================================================================
  // TEST 4: Throttling
  // ===========================================================================

  describe('throttling', () => {
    it('should not display updates within throttle interval', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 1000, write: output.write });

      // First update should display
      renderer.update({ phase: 'indexing', processedFiles: 1 });
      const countAfterFirst = output.lines.length;
      assert.strictEqual(countAfterFirst, 1, 'First update should display');

      // Rapid updates within throttle interval should NOT display
      renderer.update({ phase: 'indexing', processedFiles: 2 });
      renderer.update({ phase: 'indexing', processedFiles: 3 });
      renderer.update({ phase: 'indexing', processedFiles: 4 });

      assert.strictEqual(
        output.lines.length,
        1,
        'Updates within throttle interval should not display'
      );
    });

    it('should still update internal state even when throttled', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 1000, write: output.write });

      renderer.update({ phase: 'indexing', processedFiles: 1 });
      renderer.update({ phase: 'indexing', processedFiles: 50 });
      renderer.update({ phase: 'indexing', processedFiles: 100 });

      // State should reflect the latest update
      assert.strictEqual(
        renderer.getState().processedFiles,
        100,
        'Internal state should update even when throttled'
      );
    });

    it('should display when throttle is 0 (no throttling)', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'indexing', processedFiles: 1 });
      renderer.update({ phase: 'indexing', processedFiles: 2 });
      renderer.update({ phase: 'indexing', processedFiles: 3 });

      // All updates should display with no throttling
      assert.strictEqual(output.lines.length, 3, 'All updates should display with throttle=0');
    });
  });

  // ===========================================================================
  // TEST 5: Format accuracy for each phase
  // ===========================================================================

  describe('format accuracy', () => {
    it('should format discovery phase correctly in interactive mode', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery', servicesAnalyzed: 12 });
      const lastOutput = output.getLastLine();

      // Expected format: "| [1/5] Discovery... 12 services found"
      assert.ok(lastOutput.includes('[1/5]'), 'Should show phase 1/5');
      assert.ok(lastOutput.includes('Discovery'), 'Should show Discovery (capitalized)');
      assert.ok(lastOutput.includes('12 services'), 'Should show services count');
    });

    it('should format indexing phase correctly in interactive mode', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'indexing', totalFiles: 4047, processedFiles: 2150 });
      const lastOutput = output.getLastLine();

      assert.ok(lastOutput.includes('[2/5]'), 'Should show phase 2/5');
      assert.ok(lastOutput.includes('Indexing'), 'Should show Indexing (capitalized)');
      assert.ok(lastOutput.includes('2150/4047'), 'Should show progress fraction');
      assert.ok(lastOutput.includes('modules'), 'Should show "modules" label');
    });

    it('should format analysis phase correctly in interactive mode', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'analysis', totalFiles: 4047, processedFiles: 3000 });
      const lastOutput = output.getLastLine();

      assert.ok(lastOutput.includes('[3/5]'), 'Should show phase 3/5');
      assert.ok(lastOutput.includes('Analysis'), 'Should show Analysis (capitalized)');
      assert.ok(lastOutput.includes('3000/4047'), 'Should show progress fraction');
    });

    it('should format enrichment phase with plugins in interactive mode', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'enrichment', currentPlugin: 'ImportExportLinker' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'MethodCallResolver' });
      const lastOutput = output.getLastLine();

      assert.ok(lastOutput.includes('[4/5]'), 'Should show phase 4/5');
      assert.ok(lastOutput.includes('Enrichment'), 'Should show Enrichment (capitalized)');
      assert.ok(
        lastOutput.includes('ImportExportLinker') || lastOutput.includes('MethodCallResolver'),
        'Should show plugin names'
      );
    });

    it('should format validation phase with plugins in interactive mode', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'validation', currentPlugin: 'EvalBanValidator' });
      const lastOutput = output.getLastLine();

      assert.ok(lastOutput.includes('[5/5]'), 'Should show phase 5/5');
      assert.ok(lastOutput.includes('Validation'), 'Should show Validation (capitalized)');
      assert.ok(lastOutput.includes('EvalBanValidator'), 'Should show plugin name');
    });

    it('should format non-interactive output with [phase] prefix', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'discovery', message: 'Found 12 services' });
      assert.ok(output.getLastLine().includes('[discovery]'));

      renderer.update({ phase: 'indexing', message: 'Building dependency trees...' });
      assert.ok(output.getLastLine().includes('[indexing]'));

      renderer.update({ phase: 'analysis', message: 'Analyzing all units...' });
      assert.ok(output.getLastLine().includes('[analysis]'));
    });
  });

  // ===========================================================================
  // TEST 6: Spinner animation
  // ===========================================================================

  describe('spinner animation', () => {
    it('should increment spinner index on each update', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      const initialIndex = renderer.getState().spinnerIndex;

      renderer.update({ phase: 'discovery' });
      const afterFirst = renderer.getState().spinnerIndex;

      renderer.update({ phase: 'discovery' });
      const afterSecond = renderer.getState().spinnerIndex;

      // Spinner should cycle through frames
      assert.notStrictEqual(afterFirst, initialIndex, 'Spinner should change after first update');
      assert.notStrictEqual(afterSecond, afterFirst, 'Spinner should change after second update');
    });

    it('should cycle spinner through all frames', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      const seenIndexes = new Set<number>();

      // Update enough times to cycle through all 10 Braille frames
      for (let i = 0; i < 20; i++) {
        renderer.update({ phase: 'discovery' });
        seenIndexes.add(renderer.getState().spinnerIndex);
      }

      // Should have seen all 10 spinner frames (indexes 0-9)
      assert.strictEqual(seenIndexes.size, 10, 'Should cycle through all 10 spinner frames');
    });

    it('should show different spinner characters in output', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      const spinnerChars = new Set<string>();

      for (let i = 0; i < 20; i++) {
        renderer.update({ phase: 'discovery' });
        const line = output.lines[output.lines.length - 1];
        // Extract spinner character (Braille, after \r, before space)
        const match = line.match(/^\r([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])/);
        if (match) {
          spinnerChars.add(match[1]);
        }
      }

      assert.ok(spinnerChars.size > 1, 'Should show multiple different spinner characters');
    });
  });

  // ===========================================================================
  // TEST 7: Plugin list formatting
  // ===========================================================================

  describe('plugin list formatting', () => {
    it('should show single plugin name', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'enrichment', currentPlugin: 'MethodCallResolver' });
      const lastOutput = output.getLastLine();

      assert.ok(
        lastOutput.includes('(MethodCallResolver)'),
        `Should show plugin in parentheses. Got: ${lastOutput}`
      );
    });

    it('should show comma-separated plugin names', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'enrichment', currentPlugin: 'ImportExportLinker' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'MethodCallResolver' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'TypeResolver' });
      const lastOutput = output.getLastLine();

      assert.ok(
        lastOutput.includes('ImportExportLinker'),
        'Should show first plugin'
      );
      assert.ok(
        lastOutput.includes('MethodCallResolver'),
        'Should show second plugin'
      );
      assert.ok(
        lastOutput.includes('TypeResolver'),
        'Should show third plugin'
      );
      assert.ok(
        lastOutput.includes(', '),
        'Should separate plugins with comma'
      );
    });

    it('should truncate long plugin lists with ...', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      // Add more than 3 plugins
      renderer.update({ phase: 'enrichment', currentPlugin: 'Plugin1' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'Plugin2' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'Plugin3' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'Plugin4' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'Plugin5' });
      const lastOutput = output.getLastLine();

      assert.ok(
        lastOutput.includes('...'),
        `Long plugin list should be truncated with .... Got: ${lastOutput}`
      );
      // Should NOT show all 5 plugins
      const pluginCount = (lastOutput.match(/Plugin\d/g) || []).length;
      assert.ok(pluginCount <= 3, 'Should show at most 3 plugins before truncation');
    });

    it('should reset plugin list when phase changes', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      // Add plugins to enrichment
      renderer.update({ phase: 'enrichment', currentPlugin: 'EnricherPlugin' });
      assert.strictEqual(renderer.getState().activePlugins.length, 1);

      // Switch to validation - should reset
      renderer.update({ phase: 'validation', currentPlugin: 'ValidatorPlugin' });

      const state = renderer.getState();
      assert.strictEqual(state.activePlugins.length, 1, 'Plugin list should reset on phase change');
      assert.ok(
        state.activePlugins.includes('ValidatorPlugin'),
        'Should have new phase plugin'
      );
      assert.ok(
        !state.activePlugins.includes('EnricherPlugin'),
        'Should not have old phase plugin'
      );
    });
  });

  // ===========================================================================
  // TEST 8: Finish message
  // ===========================================================================

  describe('finish message', () => {
    it('should return formatted duration in seconds', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      const message = renderer.finish(234.56);
      assert.strictEqual(
        message,
        'Analysis complete in 234.56s',
        `Finish message format incorrect. Got: ${message}`
      );
    });

    it('should format duration with 2 decimal places', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      const message = renderer.finish(1.5);
      assert.ok(
        message.includes('1.50s'),
        `Should format 1.5 as 1.50s. Got: ${message}`
      );
    });

    it('should format integer duration with decimal places', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      const message = renderer.finish(60);
      assert.ok(
        message.includes('60.00s'),
        `Should format 60 as 60.00s. Got: ${message}`
      );
    });

    it('should format very short durations correctly', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      const message = renderer.finish(0.05);
      assert.ok(
        message.includes('0.05s'),
        `Should format 0.05 correctly. Got: ${message}`
      );
    });
  });

  // ===========================================================================
  // Additional edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle missing fields in ProgressInfo', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      // Minimal ProgressInfo with only phase
      renderer.update({ phase: 'discovery' });

      const state = renderer.getState();
      assert.strictEqual(state.phase, 'discovery');
      assert.strictEqual(state.totalFiles, 0, 'Missing totalFiles should default to 0');
      assert.strictEqual(state.processedFiles, 0, 'Missing processedFiles should default to 0');
    });

    it('should handle empty phase string', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      // Empty phase (should not crash)
      renderer.update({ phase: '' });

      assert.strictEqual(renderer.getState().phase, '');
      assert.strictEqual(renderer.getState().phaseIndex, -1, 'Empty phase should have index -1');
    });

    it('should preserve state across multiple updates to same phase', () => {
      renderer = new ProgressRenderer({ isInteractive: false, throttle: 0, write: output.write });

      renderer.update({ phase: 'indexing', totalFiles: 100 });
      renderer.update({ phase: 'indexing', processedFiles: 25 });
      renderer.update({ phase: 'indexing', processedFiles: 50 });

      const state = renderer.getState();
      assert.strictEqual(state.totalFiles, 100, 'totalFiles should be preserved');
      assert.strictEqual(state.processedFiles, 50, 'processedFiles should reflect latest');
    });

    it('should handle duplicate plugin names gracefully', () => {
      renderer = new ProgressRenderer({ isInteractive: true, throttle: 0, write: output.write });

      renderer.update({ phase: 'enrichment', currentPlugin: 'PluginA' });
      renderer.update({ phase: 'enrichment', currentPlugin: 'PluginA' }); // Duplicate
      renderer.update({ phase: 'enrichment', currentPlugin: 'PluginB' });

      const state = renderer.getState();
      // Should not have duplicate entries
      const uniquePlugins = [...new Set(state.activePlugins)];
      assert.strictEqual(
        state.activePlugins.length,
        uniquePlugins.length,
        'Should not have duplicate plugin entries'
      );
    });
  });
});
