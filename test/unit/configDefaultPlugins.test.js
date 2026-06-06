/**
 * Default plugin config must not reference deleted JS-pipeline plugins.
 *
 * The v3 migration (commit e063fc4e) removed the entire JS analysis-plugin
 * pipeline; analysis/enrichment/validation now run natively in the Rust
 * orchestrator. The TS `DEFAULT_CONFIG.plugins` lists are vestigial (read only
 * by `doctor` for reporting + `write_config`). They previously still named the
 * deleted plugins, which made `grafema doctor` (a) count nonexistent plugins as
 * "configured" and (b) warn "Plugin(s) not found" on its OWN default config
 * (the default list contained names absent from doctor's allowlist).
 *
 * Regression guard: every default plugin phase must be empty.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_CONFIG, loadConfig } from '@grafema/util';

const PHASES = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'];

describe('DEFAULT_CONFIG.plugins — no dead JS-pipeline plugin names', () => {
  it('every default plugin phase is empty', () => {
    for (const phase of PHASES) {
      assert.deepStrictEqual(
        DEFAULT_CONFIG.plugins[phase],
        [],
        `default plugins.${phase} must be empty (legacy JS plugins were removed)`,
      );
    }
  });

  it('loadConfig() on a project with no config returns empty plugin phases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grafema-cfg-'));
    try {
      const cfg = loadConfig(dir, { warn: () => {} });
      for (const phase of PHASES) {
        assert.deepStrictEqual(cfg.plugins[phase], [], `loaded default plugins.${phase} must be empty`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
