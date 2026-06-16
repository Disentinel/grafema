/**
 * REG-1166 — `imports-resolve-to-module` Datalog guarantee.
 *
 * Seeds (and locks down the behaviour of) the default guarantee that flags
 * project-internal IMPORT nodes which never resolved to a MODULE — i.e. a
 * relative import (`./x`, `../y`) with no outgoing IMPORTS_FROM edge. This is
 * the v3 GUARANTEE-system replacement for the deleted JS BrokenImportValidator
 * (REG-572) and the long-disabled `import-has-source` rule.
 *
 * HONESTY SCOPE (the crux of REG-1166): a naive
 *   `violation(X) :- node(X, "IMPORT"), \+ edge(X, _, "IMPORTS_FROM").`
 * reports every EXTERNAL dependency import (`lodash`, `react`, `std`, …) as a
 * violation, because external packages have no MODULE node to point at
 * (see js_module_imports.dl — only relative/workspace specifiers resolve, and
 * EXTERNAL_MODULE leaf nodes are not emitted yet: REG-624 / REG-687). The
 * guarantee therefore scopes to relative specifiers (`starts_with(name, ".")`),
 * which are project-internal and MUST resolve. External imports are excluded by
 * construction → zero false positives, no dependency on REG-624/687.
 *
 * Evidence the scope is correct: the JS analyzer stamps `IMPORT.name = <module
 * specifier>` (packages/js-analyzer/src/Rules/Declarations.hs:536, `gnName =
 * source`). A relative specifier always begins with ".".
 *
 * The behaviour tests run the ACTUAL rule string seeded in
 * .grafema/guarantees.yaml, so the file and the test cannot drift apart.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';

const GUARANTEE_NAME = 'imports-resolve-to-module';

/**
 * Extract a single-line `rule:` value for the named guarantee from the
 * guarantees YAML. Deliberately tiny (no external YAML dep, mirroring
 * orphaned-node-guarantees.test.ts) and scoped to one block so the test pins
 * exactly what ships.
 *
 * @param {string} content - raw guarantees.yaml text
 * @param {string} name - guarantee name to find
 * @returns {{ found: boolean, check?: string, severity?: string, rule?: string }}
 */
function extractGuarantee(content, name) {
  const lines = content.split('\n');
  let inBlock = false;
  const out = { found: false };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const nameMatch = line.match(/^\s+-\s+name:\s+(.+)$/);
    if (nameMatch) {
      // Entering a new block ends the previous one.
      if (inBlock) break;
      if (nameMatch[1].trim() === name) {
        inBlock = true;
        out.found = true;
      }
      continue;
    }
    if (!inBlock) continue;
    const field = line.match(/^\s+(check|severity):\s+(.+)$/);
    if (field) {
      out[field[1]] = field[2].trim();
      continue;
    }
    const ruleMatch = line.match(/^\s+rule:\s+(.+)$/);
    if (ruleMatch) {
      let val = ruleMatch[1].trim();
      if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1);
      }
      out.rule = val;
    }
  }
  return out;
}

const guaranteesPath = join(import.meta.dirname, '../../.grafema/guarantees.yaml');
const yamlContent = readFileSync(guaranteesPath, 'utf-8');
const seeded = extractGuarantee(yamlContent, GUARANTEE_NAME);

describe('REG-1166: imports-resolve-to-module guarantee', () => {
  let db;
  let backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  after(cleanupAllTestDatabases);

  // ── Acceptance 1: the guarantee is seeded where default guarantees live ──
  describe('seeded in .grafema/guarantees.yaml', () => {
    it('exists as a datalog guarantee', () => {
      assert.ok(seeded.found, `Guarantee "${GUARANTEE_NAME}" must be seeded in .grafema/guarantees.yaml`);
      assert.strictEqual(seeded.check, 'datalog', 'Guarantee must be a datalog check');
      assert.ok(seeded.rule, 'Guarantee must carry a rule');
    });

    it('is scoped to relative specifiers (no external-dep false positives)', () => {
      assert.match(
        seeded.rule || '',
        /starts_with\(\s*\w+\s*,\s*"\."\s*\)/,
        'Rule must scope to relative specifiers via starts_with(<var>, ".")'
      );
    });
  });

  // ── Acceptance 2: behaviour, running the SEEDED rule string ──
  describe('behaviour', () => {
    /** Add a MODULE so the importer file is well-formed. */
    async function addImporterModule() {
      await backend.addNode({
        id: 'test::module',
        type: 'MODULE',
        name: 'app.js',
        file: 'app.js',
        relativePath: 'app.js',
        contentHash: 'abc',
      });
    }

    /**
     * Add an IMPORT node. `name` is the module specifier, matching the JS
     * analyzer (Declarations.hs:536 gnName = source).
     */
    async function addImport(id, specifier) {
      await backend.addNode({
        id,
        type: 'IMPORT',
        name: specifier,
        file: 'app.js',
        source: specifier,
        specifiers: [],
      });
      await backend.addEdge({ src: 'test::module', dst: id, type: 'CONTAINS' });
    }

    it('flags a relative import with no IMPORTS_FROM edge', async () => {
      await addImporterModule();
      await addImport('test::import-rel', './broken');

      const violations = await backend.checkGuarantee(seeded.rule);
      assert.strictEqual(violations.length, 1, 'Unresolved relative import must violate');
    });

    it('flags a parent-relative import with no IMPORTS_FROM edge', async () => {
      await addImporterModule();
      await addImport('test::import-parent', '../shared/util');

      const violations = await backend.checkGuarantee(seeded.rule);
      assert.strictEqual(violations.length, 1, 'Unresolved ../ import must violate');
    });

    it('passes when a relative import resolves (has IMPORTS_FROM)', async () => {
      await addImporterModule();
      await backend.addNode({
        id: 'test::target-module',
        type: 'MODULE',
        name: 'foo.js',
        file: 'foo.js',
        relativePath: 'foo.js',
        contentHash: 'def',
      });
      await addImport('test::import-ok', './foo');
      await backend.addEdge({ src: 'test::import-ok', dst: 'test::target-module', type: 'IMPORTS_FROM' });

      const violations = await backend.checkGuarantee(seeded.rule);
      assert.strictEqual(violations.length, 0, 'Resolved relative import must not violate');
    });

    it('does NOT flag external (bare-specifier) imports with no IMPORTS_FROM', async () => {
      await addImporterModule();
      await addImport('test::import-ext-lodash', 'lodash');
      await addImport('test::import-ext-scoped', '@grafema/util');
      await addImport('test::import-ext-builtin', 'node:fs');

      const violations = await backend.checkGuarantee(seeded.rule);
      assert.strictEqual(violations.length, 0, 'External imports must be out of scope (no false positives)');
    });

    it('flags only the unresolved internal import in a mixed graph', async () => {
      await addImporterModule();
      await backend.addNode({
        id: 'test::target-module',
        type: 'MODULE',
        name: 'foo.js',
        file: 'foo.js',
        relativePath: 'foo.js',
        contentHash: 'def',
      });
      // Resolved internal — fine.
      await addImport('test::import-ok', './foo');
      await backend.addEdge({ src: 'test::import-ok', dst: 'test::target-module', type: 'IMPORTS_FROM' });
      // External — out of scope.
      await addImport('test::import-ext', 'react');
      // Unresolved internal — the one real violation.
      await addImport('test::import-bad', './missing');

      const violations = await backend.checkGuarantee(seeded.rule);
      assert.strictEqual(violations.length, 1, 'Only the unresolved internal import must violate');
    });
  });
});
