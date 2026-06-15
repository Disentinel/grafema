/**
 * Unit tests for QA-8: `grafema analyze` / `grafema resolve` verbose INFO output.
 *
 * The native grafema-orchestrator's `tracing_subscriber::fmt::init()` defaults
 * to INFO when `RUST_LOG` is unset, so the CLI passes an explicit `RUST_LOG`
 * when spawning it. Previously the default (no flags) was `'info'`, which
 * printed `INFO grafema_orchestrator: Starting analysis …` on every run — noise
 * that reads like an error to first-time users — and left `--verbose`
 * indistinguishable from the default.
 *
 * `getRustLog` now mirrors `getLogLevel`'s documented intent: quiet by default
 * (warnings/errors still surface), `--verbose` streams INFO, `--debug` streams
 * DEBUG. Backend-free — runs in the CI "CLI unit tests" subset.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getLogLevel, getRustLog, logLevelToRustLog } from '../src/commands/logLevel.js';

describe('QA-8: getRustLog — orchestrator verbosity from CLI options', () => {
  it('defaults to "warn" (quiet) so a plain `grafema analyze` does not spam INFO', () => {
    assert.equal(getRustLog({}), 'warn');
  });

  it('--verbose streams INFO logs (distinct from the quiet default)', () => {
    assert.equal(getRustLog({ verbose: true }), 'info');
  });

  it('--debug streams DEBUG diagnostics', () => {
    assert.equal(getRustLog({ debug: true }), 'debug');
  });

  it('--quiet stays quiet ("warn")', () => {
    assert.equal(getRustLog({ quiet: true }), 'warn');
  });

  it('--debug overrides other flags', () => {
    assert.equal(getRustLog({ debug: true, verbose: true, quiet: true }), 'debug');
  });

  it('--log-level is honored and mapped to the matching RUST_LOG directive', () => {
    assert.equal(getRustLog({ logLevel: 'info' }), 'info');
    assert.equal(getRustLog({ logLevel: 'debug' }), 'debug');
    assert.equal(getRustLog({ logLevel: 'warnings' }), 'warn');
    assert.equal(getRustLog({ logLevel: 'errors' }), 'error');
    assert.equal(getRustLog({ logLevel: 'silent' }), 'warn');
  });

  it('keeps warnings visible by default (does not map quiet to "error"/"off")', () => {
    // Genuine warnings — failed parses, skipped oversized files, resolver
    // fallbacks — must never be hidden, even on a default quiet run.
    assert.equal(getRustLog({}), 'warn');
  });

  it('an unknown --log-level value falls back to the quiet default', () => {
    assert.equal(getRustLog({ logLevel: 'bogus' }), 'warn');
  });
});

describe('QA-8: getLogLevel — CLI-side log level precedence', () => {
  it('defaults to silent for a clean progress UI', () => {
    assert.equal(getLogLevel({}), 'silent');
  });

  it('--log-level takes precedence over --quiet / --verbose', () => {
    assert.equal(getLogLevel({ logLevel: 'info', quiet: true, verbose: true }), 'info');
  });

  it('--quiet takes precedence over --verbose', () => {
    assert.equal(getLogLevel({ quiet: true, verbose: true }), 'silent');
  });
});

describe('QA-8: logLevelToRustLog — level → RUST_LOG mapping', () => {
  it('maps every LogLevel to a concrete RUST_LOG directive', () => {
    assert.equal(logLevelToRustLog('debug'), 'debug');
    assert.equal(logLevelToRustLog('info'), 'info');
    assert.equal(logLevelToRustLog('warnings'), 'warn');
    assert.equal(logLevelToRustLog('errors'), 'error');
    assert.equal(logLevelToRustLog('silent'), 'warn');
  });
});
