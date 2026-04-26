# Linus Torvalds' Plan Review: REG-147

**Date:** January 23, 2026

## Status: APPROVED ✓

## Initial Concern (RESOLVED)

I initially rejected this plan due to concerns about `success: true` with non-empty `errors[]` being semantically wrong.

**However, I missed the integration tests from REG-78 that establish this as the INTENDED pattern.**

## Evidence: test/integration/error-handling.test.ts

Lines 108-132 - `MockWarningPlugin`:
```typescript
class MockWarningPlugin implements IPlugin {
  async execute(_context: PluginContext): Promise<PluginResult> {
    const error = new LanguageError(
      'Unsupported file type: .rs',
      'ERR_UNSUPPORTED_LANG',
      { filePath: 'src/lib.rs', plugin: this.metadata.name },
      'Use RustAnalyzer plugin for Rust files'
    );

    return {
      success: true, // Warnings don't fail  <-- DOCUMENTED PATTERN
      created: { nodes: 10, edges: 5 },
      errors: [error],  // LanguageError with severity: 'warning'
      warnings: ['Skipped 1 file'],
      metadata: {},
    };
  }
}
```

Lines 719-732 - Explicit test:
```typescript
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
```

## Architecture Clarity

The REG-78 infrastructure was designed with this distinction:

| Scenario | success | errors[] | Severity | Exit Code |
|----------|---------|----------|----------|-----------|
| Fully successful | true | [] | - | 0 |
| Success with warnings | true | [LanguageError] | warning | 0 |
| Failure with errors | false | [FileAccessError] | error | 2 |
| Fatal failure | false | [DatabaseError] | fatal | 1 |

The `severity` field on `GrafemaError` distinguishes between warnings (non-fatal) and errors (fatal). The `success` field indicates whether the plugin completed its execution.

**This is NOT a semantic lie.** It's a well-designed architecture where:
- `success` = "plugin finished executing"
- `errors[].severity` = "how bad is each issue"

## Verdict

**APPROVED.** Joel's plan correctly follows the established REG-78 pattern.

Proceed with implementation.
