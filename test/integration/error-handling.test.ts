/**
 * Error Handling Integration Tests
 *
 * Integration tests for the error handling and diagnostics pipeline.
 * Based on specification: _tasks/2026-01-23-reg-78-error-handling-diagnostics/003-joel-tech-plan.md
 *
 * Tests:
 * - Plugin error flows through to DiagnosticCollector
 * - Orchestrator throws on fatal error
 * - Full pipeline: Plugin -> PluginResult -> Collector -> Reporter
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  GrafemaError,
  ConfigError,
  FileAccessError,
  LanguageError,
  DatabaseError,
  PluginError,
  AnalysisError,
  DiagnosticCollector,
  DiagnosticReporter,
} from '@grafema/core';

import type {
  PluginResult,
  PluginPhase,
  PluginContext,
  PluginMetadata,
  IPlugin,
  GraphBackend,
} from '@grafema/types';

// =============================================================================
// Mock GraphBackend for Integration Testing
// =============================================================================

/**
 * Mock GraphBackend for testing
 */
class MockGraphBackend implements Partial<GraphBackend> {
  private nodes: Map<string, unknown> = new Map();
  private edges: unknown[] = [];

  async addNode(node: { id: string }): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge: unknown): Promise<void> {
    this.edges.push(edge);
  }

  async addNodes(nodes: { id: string }[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  async addEdges(edges: unknown[]): Promise<void> {
    this.edges.push(...edges);
  }

  async getNode(id: string): Promise<unknown> {
    return this.nodes.get(id) || null;
  }

  async nodeCount(): Promise<number> {
    return this.nodes.size;
  }

  async edgeCount(): Promise<number> {
    return this.edges.length;
  }
}

// =============================================================================
// Mock Plugins for Testing
// =============================================================================

/**
 * Base mock plugin that returns success
 */
class MockSuccessPlugin implements IPlugin {
  config: Record<string, unknown> = {};
  metadata: PluginMetadata;

  constructor(name: string, phase: PluginPhase) {
    this.metadata = { name, phase };
  }

  async execute(_context: PluginContext): Promise<PluginResult> {
    return {
      success: true,
      created: { nodes: 5, edges: 3 },
      errors: [],
      warnings: [],
      metadata: {},
    };
  }
}

/**
 * Mock plugin that returns warnings (LanguageError - severity: warning)
 */
class MockWarningPlugin implements IPlugin {
  config: Record<string, unknown> = {};
  metadata: PluginMetadata;

  constructor(name: string, phase: PluginPhase) {
    this.metadata = { name, phase };
  }

  async execute(_context: PluginContext): Promise<PluginResult> {
    const error = new LanguageError(
      'Unsupported file type: .rs',
      'ERR_UNSUPPORTED_LANG',
      { filePath: 'src/lib.rs', plugin: this.metadata.name },
      'Use RustAnalyzer plugin for Rust files'
    );

    return {
      success: true, // Warnings don't fail
      created: { nodes: 10, edges: 5 },
      errors: [error],
      warnings: ['Skipped 1 file'],
      metadata: {},
    };
  }
}

/**
 * Mock plugin that returns errors (FileAccessError - severity: error)
 */
class MockErrorPlugin implements IPlugin {
  config: Record<string, unknown> = {};
  metadata: PluginMetadata;

  constructor(name: string, phase: PluginPhase) {
    this.metadata = { name, phase };
  }

  async execute(_context: PluginContext): Promise<PluginResult> {
    const error = new FileAccessError(
      'Cannot read file: permission denied',
      'ERR_FILE_UNREADABLE',
      { filePath: 'src/secrets.json', plugin: this.metadata.name },
      'Check file permissions'
    );

    return {
      success: false,
      created: { nodes: 0, edges: 0 },
      errors: [error],
      warnings: [],
      metadata: {},
    };
  }
}

/**
 * Mock plugin that returns fatal error (DatabaseError - severity: fatal)
 */
class MockFatalPlugin implements IPlugin {
  config: Record<string, unknown> = {};
  metadata: PluginMetadata;

  constructor(name: string, phase: PluginPhase) {
    this.metadata = { name, phase };
  }

  async execute(_context: PluginContext): Promise<PluginResult> {
    const error = new DatabaseError(
      'Database is locked by another process',
      'ERR_DATABASE_LOCKED',
      { plugin: this.metadata.name },
      'Close other Grafema instances'
    );

    return {
      success: false,
      created: { nodes: 0, edges: 0 },
      errors: [error],
      warnings: [],
      metadata: {},
    };
  }
}

/**
 * Mock plugin that throws an exception (not returns error)
 */
class MockThrowingPlugin implements IPlugin {
  config: Record<string, unknown> = {};
  metadata: PluginMetadata;

  constructor(name: string, phase: PluginPhase) {
    this.metadata = { name, phase };
  }

  async execute(_context: PluginContext): Promise<PluginResult> {
    throw new Error('Plugin crashed unexpectedly');
  }
}

/**
 * Mock plugin that returns multiple errors
 */
class MockMultiErrorPlugin implements IPlugin {
  config: Record<string, unknown> = {};
  metadata: PluginMetadata;

  constructor(name: string, phase: PluginPhase) {
    this.metadata = { name, phase };
  }

  async execute(_context: PluginContext): Promise<PluginResult> {
    const errors = [
      new LanguageError(
        'Parse error in file1.js',
        'ERR_PARSE_FAILURE',
        { filePath: 'src/file1.js', lineNumber: 10 },
        'Fix syntax error'
      ),
      new LanguageError(
        'Parse error in file2.js',
        'ERR_PARSE_FAILURE',
        { filePath: 'src/file2.js', lineNumber: 25 },
        'Fix syntax error'
      ),
      new FileAccessError(
        'Cannot read file3.js',
        'ERR_FILE_UNREADABLE',
        { filePath: 'src/file3.js' }
      ),
    ];

    return {
      success: false,
      created: { nodes: 5, edges: 2 },
      errors,
      warnings: ['Partial analysis completed'],
      metadata: { filesProcessed: 10, filesSkipped: 3 },
    };
  }
}

// =============================================================================
// Mock Orchestrator for Integration Testing
// =============================================================================

/**
 * Simplified orchestrator for integration testing
 * Tests the error collection and fatal error handling
 */
class MockOrchestrator {
  private diagnosticCollector: DiagnosticCollector;
  private plugins: IPlugin[];
  private graph: GraphBackend;

  constructor(options: {
    plugins: IPlugin[];
    graph?: GraphBackend;
    diagnosticCollector?: DiagnosticCollector;
  }) {
    this.plugins = options.plugins;
    this.graph = (options.graph || new MockGraphBackend()) as GraphBackend;
    this.diagnosticCollector = options.diagnosticCollector || new DiagnosticCollector();
  }

  async runPhase(phase: PluginPhase): Promise<void> {
    const phasePlugins = this.plugins.filter(p => p.metadata.phase === phase);

    for (const plugin of phasePlugins) {
      try {
        const result = await plugin.execute({
          graph: this.graph,
          phase,
        });

        // Collect diagnostics from result
        this.diagnosticCollector.addFromPluginResult(
          phase,
          plugin.metadata.name,
          result
        );

        // Check for fatal - stop immediately
        if (this.diagnosticCollector.hasFatal()) {
          const fatal = this.diagnosticCollector.getAll().find(d => d.severity === 'fatal');
          throw new Error(`Fatal error in ${plugin.metadata.name}: ${fatal?.message}`);
        }
      } catch (error) {
        // Plugin threw exception
        if (error instanceof Error && error.message.startsWith('Fatal error in')) {
          // Re-throw fatal error from result
          throw error;
        }

        // Unexpected exception - record as fatal
        this.diagnosticCollector.add({
          code: 'ERR_PLUGIN_THREW',
          severity: 'fatal',
          message: error instanceof Error ? error.message : String(error),
          phase,
          plugin: plugin.metadata.name,
        });

        throw error;
      }
    }
  }

  async run(): Promise<void> {
    await this.runPhase('DISCOVERY');
    await this.runPhase('INDEXING');
    await this.runPhase('ANALYSIS');
    await this.runPhase('ENRICHMENT');
    await this.runPhase('VALIDATION');
  }

  getDiagnostics(): DiagnosticCollector {
    return this.diagnosticCollector;
  }
}

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Error Handling Integration', () => {
  // ===========================================================================
  // TESTS: Plugin error flows through to DiagnosticCollector
  // ===========================================================================

  describe('Plugin error flows through to DiagnosticCollector', () => {
    it('should collect warning from plugin into DiagnosticCollector', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockWarningPlugin('JSModuleIndexer', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      assert.strictEqual(collector.count(), 1);
      const diag = collector.getAll()[0];
      assert.strictEqual(diag.code, 'ERR_UNSUPPORTED_LANG');
      assert.strictEqual(diag.severity, 'warning');
      assert.strictEqual(diag.plugin, 'JSModuleIndexer');
      assert.strictEqual(diag.phase, 'INDEXING');
    });

    it('should collect error from plugin into DiagnosticCollector', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockErrorPlugin('FileReader', 'DISCOVERY')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('DISCOVERY');

      assert.strictEqual(collector.count(), 1);
      const diag = collector.getAll()[0];
      assert.strictEqual(diag.code, 'ERR_FILE_UNREADABLE');
      assert.strictEqual(diag.severity, 'error');
      assert.strictEqual(diag.plugin, 'FileReader');
    });

    it('should collect multiple errors from single plugin', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockMultiErrorPlugin('MultiErrorPlugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      assert.strictEqual(collector.count(), 3);

      const parseErrors = collector.getByCode('ERR_PARSE_FAILURE');
      const fileErrors = collector.getByCode('ERR_FILE_UNREADABLE');

      assert.strictEqual(parseErrors.length, 2);
      assert.strictEqual(fileErrors.length, 1);
    });

    it('should collect errors from multiple plugins in same phase', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [
          new MockWarningPlugin('Plugin1', 'INDEXING'),
          new MockErrorPlugin('Plugin2', 'INDEXING'),
        ],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      assert.strictEqual(collector.count(), 2);
      assert.strictEqual(collector.getByPlugin('Plugin1').length, 1);
      assert.strictEqual(collector.getByPlugin('Plugin2').length, 1);
    });

    it('should collect errors across different phases', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [
          new MockWarningPlugin('DiscoveryPlugin', 'DISCOVERY'),
          new MockErrorPlugin('IndexingPlugin', 'INDEXING'),
          new MockWarningPlugin('AnalysisPlugin', 'ANALYSIS'),
        ],
        diagnosticCollector: collector,
      });

      // Note: Would stop at fatal, but these are not fatal
      await orchestrator.runPhase('DISCOVERY');
      await orchestrator.runPhase('INDEXING');
      await orchestrator.runPhase('ANALYSIS');

      assert.strictEqual(collector.count(), 3);
      assert.strictEqual(collector.getByPhase('DISCOVERY').length, 1);
      assert.strictEqual(collector.getByPhase('INDEXING').length, 1);
      assert.strictEqual(collector.getByPhase('ANALYSIS').length, 1);
    });

    it('should preserve GrafemaError properties in diagnostic', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockWarningPlugin('TestPlugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      const diag = collector.getAll()[0];
      assert.strictEqual(diag.file, 'src/lib.rs');
      assert.strictEqual(diag.suggestion, 'Use RustAnalyzer plugin for Rust files');
    });

    it('should handle plain Error (not GrafemaError) with generic info', async () => {
      // Create a plugin that returns plain Error
      const plainErrorPlugin: IPlugin = {
        config: {},
        metadata: { name: 'PlainErrorPlugin', phase: 'INDEXING' },
        async execute(): Promise<PluginResult> {
          return {
            success: false,
            created: { nodes: 0, edges: 0 },
            errors: [new Error('Plain error message')],
            warnings: [],
            metadata: {},
          };
        },
      };

      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [plainErrorPlugin],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      const diag = collector.getAll()[0];
      assert.strictEqual(diag.code, 'ERR_UNKNOWN');
      assert.strictEqual(diag.severity, 'error');
      assert.strictEqual(diag.message, 'Plain error message');
    });
  });

  // ===========================================================================
  // TESTS: Orchestrator throws on fatal error
  // ===========================================================================

  describe('Orchestrator throws on fatal error', () => {
    it('should throw when plugin returns fatal error', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockFatalPlugin('DatabasePlugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await assert.rejects(
        () => orchestrator.runPhase('INDEXING'),
        (error: Error) => {
          assert.ok(error.message.includes('Fatal error'));
          assert.ok(error.message.includes('DatabasePlugin'));
          return true;
        }
      );
    });

    it('should collect fatal diagnostic before throwing', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockFatalPlugin('DatabasePlugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      try {
        await orchestrator.runPhase('INDEXING');
      } catch {
        // Expected
      }

      assert.strictEqual(collector.hasFatal(), true);
      const diag = collector.getAll()[0];
      assert.strictEqual(diag.code, 'ERR_DATABASE_LOCKED');
      assert.strictEqual(diag.severity, 'fatal');
    });

    it('should stop processing after fatal error', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [
          new MockFatalPlugin('FatalPlugin', 'INDEXING'),
          new MockWarningPlugin('SecondPlugin', 'INDEXING'),
        ],
        diagnosticCollector: collector,
      });

      try {
        await orchestrator.runPhase('INDEXING');
      } catch {
        // Expected
      }

      // Only fatal plugin should have run
      assert.strictEqual(collector.count(), 1);
      assert.strictEqual(collector.getByPlugin('SecondPlugin').length, 0);
    });

    it('should throw when plugin throws exception', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockThrowingPlugin('CrashingPlugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await assert.rejects(
        () => orchestrator.runPhase('INDEXING'),
        (error: Error) => {
          assert.ok(error.message.includes('crashed unexpectedly'));
          return true;
        }
      );
    });

    it('should record thrown exception as fatal diagnostic', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockThrowingPlugin('CrashingPlugin', 'ANALYSIS')],
        diagnosticCollector: collector,
      });

      try {
        await orchestrator.runPhase('ANALYSIS');
      } catch {
        // Expected
      }

      assert.strictEqual(collector.hasFatal(), true);
      const diag = collector.getAll()[0];
      assert.strictEqual(diag.code, 'ERR_PLUGIN_THREW');
      assert.strictEqual(diag.severity, 'fatal');
      assert.strictEqual(diag.plugin, 'CrashingPlugin');
    });
  });

  // ===========================================================================
  // TESTS: Full pipeline: Plugin -> PluginResult -> Collector -> Reporter
  // ===========================================================================

  describe('Full pipeline: Plugin -> PluginResult -> Collector -> Reporter', () => {
    it('should flow from plugin through collector to reporter', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [
          new MockWarningPlugin('WarningPlugin', 'INDEXING'),
          new MockErrorPlugin('ErrorPlugin', 'INDEXING'),
        ],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      // Collector has diagnostics
      assert.strictEqual(collector.count(), 2);
      assert.strictEqual(collector.hasErrors(), true);
      assert.strictEqual(collector.hasWarnings(), true);

      // Reporter can format them
      const reporter = new DiagnosticReporter(collector);
      const textReport = reporter.report({ format: 'text' });

      assert.ok(textReport.includes('ERR_UNSUPPORTED_LANG'));
      assert.ok(textReport.includes('ERR_FILE_UNREADABLE'));
    });

    it('should generate correct summary', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [
          new MockMultiErrorPlugin('MultiPlugin', 'INDEXING'),
        ],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      const reporter = new DiagnosticReporter(collector);
      const summary = reporter.summary();

      // MultiErrorPlugin returns 2 warnings + 1 error
      assert.ok(
        summary.includes('Warning') || summary.includes('warning') || summary.includes('2'),
        `Summary should mention warnings: ${summary}`
      );
      assert.ok(
        summary.includes('Error') || summary.includes('error') || summary.includes('1'),
        `Summary should mention errors: ${summary}`
      );
    });

    it('should generate valid JSON report', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockWarningPlugin('Plugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      const reporter = new DiagnosticReporter(collector);
      const jsonReport = reporter.report({ format: 'json' });

      assert.doesNotThrow(() => JSON.parse(jsonReport));

      const parsed = JSON.parse(jsonReport);
      assert.ok(Array.isArray(parsed.diagnostics));
      assert.strictEqual(parsed.diagnostics.length, 1);
    });

    it('should include all diagnostic details in report', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockWarningPlugin('TestPlugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      const reporter = new DiagnosticReporter(collector);
      const jsonReport = reporter.report({ format: 'json' });
      const parsed = JSON.parse(jsonReport);
      const diag = parsed.diagnostics[0];

      assert.strictEqual(diag.code, 'ERR_UNSUPPORTED_LANG');
      assert.strictEqual(diag.severity, 'warning');
      assert.strictEqual(diag.file, 'src/lib.rs');
      assert.strictEqual(diag.plugin, 'TestPlugin');
      assert.strictEqual(diag.phase, 'INDEXING');
      assert.ok(diag.suggestion);
    });

    it('should produce valid diagnostics.log format', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [
          new MockWarningPlugin('Plugin1', 'INDEXING'),
          new MockErrorPlugin('Plugin2', 'INDEXING'),
        ],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      const log = collector.toDiagnosticsLog();
      const lines = log.split('\n').filter(l => l.trim());

      assert.strictEqual(lines.length, 2);

      // Each line is valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line);
        assert.ok(parsed.code);
        assert.ok(parsed.severity);
        assert.ok(parsed.message);
        assert.ok(parsed.plugin);
        assert.ok(parsed.phase);
        assert.ok(typeof parsed.timestamp === 'number');
      }
    });
  });

  // ===========================================================================
  // TESTS: Exit codes (simulated)
  // ===========================================================================

  describe('Exit code determination', () => {
    it('should indicate success (exit 0) when no errors', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockSuccessPlugin('Plugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      // CLI would check these to determine exit code
      assert.strictEqual(collector.hasFatal(), false);
      assert.strictEqual(collector.hasErrors(), false);
      // Exit code would be 0
    });

    it('should indicate success with warnings (exit 0)', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockWarningPlugin('Plugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      assert.strictEqual(collector.hasFatal(), false);
      assert.strictEqual(collector.hasErrors(), false);
      assert.strictEqual(collector.hasWarnings(), true);
      // Exit code would be 0 (warnings don't fail)
    });

    it('should indicate errors (exit 2) when has non-fatal errors', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockErrorPlugin('Plugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      await orchestrator.runPhase('INDEXING');

      assert.strictEqual(collector.hasFatal(), false);
      assert.strictEqual(collector.hasErrors(), true);
      // Exit code would be 2
    });

    it('should indicate fatal (exit 1) when has fatal error', async () => {
      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [new MockFatalPlugin('Plugin', 'INDEXING')],
        diagnosticCollector: collector,
      });

      try {
        await orchestrator.runPhase('INDEXING');
      } catch {
        // Expected
      }

      assert.strictEqual(collector.hasFatal(), true);
      // Exit code would be 1
    });
  });

  // ===========================================================================
  // TESTS: Real-world scenario
  // ===========================================================================

  describe('Real-world scenario', () => {
    it('should handle typical analysis with mixed results', async () => {
      // Simulate a real analysis run:
      // - Discovery succeeds
      // - Indexing has some warnings and one error
      // - Analysis proceeds with partial data

      const collector = new DiagnosticCollector();
      const orchestrator = new MockOrchestrator({
        plugins: [
          new MockSuccessPlugin('ProjectDiscovery', 'DISCOVERY'),
          new MockWarningPlugin('JSModuleIndexer', 'INDEXING'),
          new MockMultiErrorPlugin('TypeScriptIndexer', 'INDEXING'),
          new MockSuccessPlugin('DataFlowAnalyzer', 'ANALYSIS'),
        ],
        diagnosticCollector: collector,
      });

      // Run phases
      await orchestrator.runPhase('DISCOVERY');
      await orchestrator.runPhase('INDEXING');
      await orchestrator.runPhase('ANALYSIS');

      // Verify diagnostics were collected
      assert.ok(collector.count() > 0);
      assert.ok(collector.hasErrors());
      assert.ok(collector.hasWarnings());
      assert.ok(!collector.hasFatal());

      // Generate report
      const reporter = new DiagnosticReporter(collector);
      const report = reporter.report({ format: 'text', includeSummary: true });

      // Report should be useful
      assert.ok(report.includes('INDEXING') || report.includes('ERR_'));
      assert.ok(report.length > 100); // Not empty
    });
  });
});
