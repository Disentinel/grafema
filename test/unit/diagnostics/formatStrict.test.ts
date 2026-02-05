/**
 * DiagnosticReporter.formatStrict() Tests (REG-332)
 *
 * Tests for strict mode formatting with resolution chain
 * and hybrid progressive disclosure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { DiagnosticCollector, DiagnosticReporter } from '@grafema/core';
import type { Diagnostic, ResolutionStep } from '@grafema/core';

// Helper to create test diagnostics
function createDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'STRICT_UNRESOLVED_METHOD',
    severity: 'fatal',
    message: 'Cannot resolve method call: user.processData',
    file: '/tmp/test.js',
    line: 3,
    phase: 'ENRICHMENT',
    plugin: 'MethodCallResolver',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('DiagnosticReporter.formatStrict()', () => {
  describe('basic formatting', () => {
    it('should format diagnostic with location', () => {
      const diagnostics: Diagnostic[] = [{
        code: 'STRICT_UNRESOLVED_METHOD',
        severity: 'fatal',
        message: 'Cannot resolve method call: user.processData',
        file: '/tmp/test.js',
        line: 3,
        phase: 'ENRICHMENT',
        plugin: 'MethodCallResolver',
        timestamp: Date.now(),
        suggestion: 'Check if class is imported',
      }];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(output.includes('STRICT_UNRESOLVED_METHOD'), 'Should include error code');
      assert.ok(output.includes('/tmp/test.js:3'), 'Should include location');
      assert.ok(output.includes('Cannot resolve method call'), 'Should include message');
      assert.ok(output.includes('Suggestion:'), 'Should include suggestion label');
      assert.ok(output.includes('Check if class is imported'), 'Should include suggestion text');
    });

    it('should handle multiple diagnostics', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ code: 'ERROR_1', message: 'First error' }),
        createDiagnostic({ code: 'ERROR_2', message: 'Second error' }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(output.includes('ERROR_1'), 'Should include first error');
      assert.ok(output.includes('ERROR_2'), 'Should include second error');
      assert.ok(output.includes('First error'), 'Should include first message');
      assert.ok(output.includes('Second error'), 'Should include second message');
    });

    it('should handle diagnostic without file info', () => {
      const diagnostics: Diagnostic[] = [{
        code: 'STRICT_ERROR',
        severity: 'fatal',
        message: 'Some error',
        phase: 'ENRICHMENT',
        plugin: 'TestPlugin',
        timestamp: Date.now(),
      }];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);

      // Should not throw
      const output = reporter.formatStrict(diagnostics);
      assert.ok(output.includes('STRICT_ERROR'), 'Should include error code');
      assert.ok(output.includes('Some error'), 'Should include message');
    });

    it('should handle diagnostic without suggestion', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ suggestion: undefined }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(!output.includes('Suggestion:'), 'Should not include suggestion label when no suggestion');
    });
  });

  describe('resolution chain display', () => {
    it('should display resolution chain when present', () => {
      const chain: ResolutionStep[] = [
        { step: 'getUser() return', result: 'unknown (not declared)', file: '/tmp/test.js', line: 1 },
        { step: 'user variable', result: 'inherits unknown type' },
        { step: 'user.processData', result: 'FAILED (no type information)' },
      ];

      const diagnostics: Diagnostic[] = [{
        code: 'STRICT_UNRESOLVED_METHOD',
        severity: 'fatal',
        message: 'Cannot resolve method call: user.processData',
        file: '/tmp/test.js',
        line: 3,
        phase: 'ENRICHMENT',
        plugin: 'MethodCallResolver',
        timestamp: Date.now(),
        suggestion: 'Add return type to getUser()',
        resolutionChain: chain,
      }];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(output.includes('Resolution chain:'), 'Should include chain header');
      assert.ok(output.includes('getUser() return -> unknown'), 'Should show first step');
      assert.ok(output.includes('user variable -> inherits'), 'Should show second step');
      assert.ok(output.includes('FAILED'), 'Should show failure step');
    });

    it('should include step location when provided', () => {
      const chain: ResolutionStep[] = [
        { step: 'getUser() return', result: 'unknown', file: '/tmp/test.js', line: 1 },
      ];

      const diagnostics: Diagnostic[] = [
        createDiagnostic({ resolutionChain: chain }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(output.includes('(/tmp/test.js:1)'), 'Should include step location');
    });

    it('should handle empty resolution chain', () => {
      const diagnostics: Diagnostic[] = [{
        code: 'STRICT_UNRESOLVED_METHOD',
        severity: 'fatal',
        message: 'Some error',
        phase: 'ENRICHMENT',
        plugin: 'TestPlugin',
        timestamp: Date.now(),
        resolutionChain: [],
      }];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(!output.includes('Resolution chain:'), 'Should not include chain header when empty');
    });
  });

  describe('hybrid progressive disclosure', () => {
    it('should show chain by default for <=3 errors', () => {
      const chain: ResolutionStep[] = [
        { step: 'test', result: 'result' },
      ];

      const diagnostics: Diagnostic[] = [
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(output.includes('Resolution chain:'), 'Should show chain for <=3 errors');
    });

    it('should hide chain by default for >3 errors', () => {
      const chain: ResolutionStep[] = [
        { step: 'test', result: 'result' },
      ];

      const diagnostics: Diagnostic[] = [
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(!output.includes('Resolution chain:'), 'Should hide chain for >3 errors');
      assert.ok(output.includes('--verbose'), 'Should suggest --verbose');
    });

    it('should show chain with verbose=true regardless of count', () => {
      const chain: ResolutionStep[] = [
        { step: 'test', result: 'result' },
      ];

      const diagnostics: Diagnostic[] = [
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
        createDiagnostic({ resolutionChain: chain }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics, { verbose: true });

      assert.ok(output.includes('Resolution chain:'), 'Should show chain when verbose=true');
      assert.ok(!output.includes('--verbose'), 'Should not suggest --verbose when already verbose');
    });

    it('should hide chain with verbose=false even for <=3 errors', () => {
      const chain: ResolutionStep[] = [
        { step: 'test', result: 'result' },
      ];

      const diagnostics: Diagnostic[] = [
        createDiagnostic({ resolutionChain: chain }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics, { verbose: false });

      assert.ok(!output.includes('Resolution chain:'), 'Should hide chain when verbose=false');
    });
  });

  describe('output format', () => {
    it('should separate multiple diagnostics with dividers', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ code: 'ERROR_1' }),
        createDiagnostic({ code: 'ERROR_2' }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(output.includes('---'), 'Should include separator between errors');
    });

    it('should not end with trailing separator', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ code: 'ERROR_1' }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics);

      assert.ok(!output.trim().endsWith('---'), 'Should not end with separator');
    });
  });

  describe('suppression summary (REG-332)', () => {
    it('should show suppression count when provided', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ code: 'ERROR_1' }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics, { suppressedCount: 5 });

      assert.ok(output.includes('5 error(s) suppressed'), 'Should show suppressed count');
      assert.ok(output.includes('grafema-ignore'), 'Should mention grafema-ignore');
    });

    it('should not show suppression summary when count is 0', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ code: 'ERROR_1' }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics, { suppressedCount: 0 });

      assert.ok(!output.includes('suppressed'), 'Should not show suppressed when count is 0');
    });

    it('should not show suppression summary when count is undefined', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ code: 'ERROR_1' }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics, {});

      assert.ok(!output.includes('suppressed'), 'Should not show suppressed when undefined');
    });

    it('should show singular form for 1 suppressed error', () => {
      const diagnostics: Diagnostic[] = [
        createDiagnostic({ code: 'ERROR_1' }),
      ];

      const collector = new DiagnosticCollector();
      const reporter = new DiagnosticReporter(collector);
      const output = reporter.formatStrict(diagnostics, { suppressedCount: 1 });

      assert.ok(output.includes('1 error(s) suppressed'), 'Should show 1 error(s)');
    });
  });
});
