/**
 * Tests for docs-md renderer (REG-1116, REG-1118).
 *
 * Validates:
 *   - Multi-feature mode (REG-1116): top-level title, TOC, per-feature
 *     sections.
 *   - Single-feature mode (REG-1118): just the feature section, no TOC.
 *   - All four FEATURE categories (cli/mcp/vscode/http) render without crash.
 *   - Behavior block omitted when absent; shared-with block omitted when
 *     empty.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { docsMdRenderer } from '@grafema/util/exporters/docsMd';

function cliSnap() {
  return {
    id: 'feat:cli:analyze',
    category: 'cli:command',
    name: 'analyze',
    file: 'packages/cli/src/commands/analyze.ts',
    contracts: [
      {
        source: 'commander',
        inputs: [
          { name: '--project', type: 'string', optional: true, default: '.', description: 'Project path' },
          { name: '--json', type: 'boolean', optional: true, description: 'Output as JSON' },
        ],
        outputs: [{ description: 'Show project overview and statistics' }],
        errors: [{ type: 'AnalysisError', description: 'Analysis failed' }],
      },
    ],
    behavior: { hash: 'a'.repeat(64), effects: ['ASYNC', 'IO'], coreNodeCount: 47, depth: 9 },
    sharedBehaviorWith: [
      { id: 'feat:mcp:analyze_project', category: 'mcp:tool', name: 'analyze_project', file: 'packages/mcp/src/x.ts' },
    ],
  };
}

function mcpSnap() {
  return {
    id: 'feat:mcp:analyze_project',
    category: 'mcp:tool',
    name: 'analyze_project',
    file: 'packages/mcp/src/x.ts',
    contracts: [
      {
        source: 'mcp-inputSchema',
        inputs: [{ name: 'force', type: 'boolean', optional: true }],
        outputs: [],
        errors: [],
      },
    ],
    behavior: { hash: 'a'.repeat(64), effects: ['ASYNC', 'IO'], coreNodeCount: 47, depth: 9 },
    sharedBehaviorWith: [],
  };
}

function vscodeSnap() {
  return {
    id: 'feat:vscode:open',
    category: 'vscode:command',
    name: 'grafema.openMap',
    file: 'packages/vscode/src/extension.ts',
    contracts: [
      {
        source: 'vscode-contributes',
        inputs: [],
        outputs: [{ description: 'Open the Grafema map panel' }],
        errors: [],
      },
    ],
    behavior: undefined,
    sharedBehaviorWith: [],
  };
}

function httpSnap() {
  return {
    id: 'feat:http:get-user',
    category: 'http:route',
    name: 'getUser',
    file: 'src/routes.ts',
    contracts: [
      {
        source: 'http-route',
        inputs: [{ name: 'id', type: 'string', optional: false, description: 'Path parameter from route' }],
        outputs: [{ description: 'GET /users/:id' }],
        errors: [],
      },
    ],
    behavior: undefined,
    sharedBehaviorWith: [],
  };
}

describe('docsMdRenderer', () => {
  it('format identifier and accepts every category', () => {
    assert.equal(docsMdRenderer.format, 'docs-md');
    for (const c of ['cli:command', 'mcp:tool', 'vscode:command', 'package:export', 'http:route', 'foo:bar']) {
      assert.equal(docsMdRenderer.supports(c), true, `should support ${c}`);
    }
  });

  it('empty snapshots → catalogue header with explanatory note', () => {
    const text = docsMdRenderer.render([]);
    assert.match(text, /# Grafema feature catalogue/);
    assert.match(text, /No features matched/);
  });

  it('single-feature mode (REG-1118): no TOC, no top-level catalogue header', () => {
    const text = docsMdRenderer.render([cliSnap()]);
    // No catalogue title.
    assert.doesNotMatch(text, /^# Grafema feature catalogue/m);
    assert.doesNotMatch(text, /## Contents/);
    // Has the feature section header.
    assert.match(text, /## `cli:command` `analyze`/);
    // Has contract table.
    assert.match(text, /\| Input \| Type \| Optional \| Default \| Description \|/);
    // Has behavior block.
    assert.match(text, /### Behavior/);
    assert.match(text, /Effects: ASYNC, IO/);
    assert.match(text, /Transitive calls: 47/);
    assert.match(text, /Depth: 9/);
    // Has shared-with block.
    assert.match(text, /### Shared with/);
    assert.match(text, /`mcp:tool` `analyze_project`/);
  });

  it('multi-feature mode (REG-1116): top-level header + TOC + sections', () => {
    const text = docsMdRenderer.render([cliSnap(), mcpSnap(), vscodeSnap(), httpSnap()]);
    assert.match(text, /^# Grafema feature catalogue/m);
    assert.match(text, /## Contents/);
    // TOC entries for each feature.
    assert.match(text, /\[`cli:command` `analyze`\]/);
    assert.match(text, /\[`mcp:tool` `analyze_project`\]/);
    assert.match(text, /\[`vscode:command` `grafema.openMap`\]/);
    assert.match(text, /\[`http:route` `getUser`\]/);
    // All four categories produce a section.
    assert.match(text, /## `cli:command` `analyze`/);
    assert.match(text, /## `mcp:tool` `analyze_project`/);
    assert.match(text, /## `vscode:command` `grafema\.openMap`/);
    assert.match(text, /## `http:route` `getUser`/);
  });

  it('feature with no contracts gets a placeholder line', () => {
    const snap = cliSnap();
    snap.contracts = [];
    const text = docsMdRenderer.render([snap]);
    assert.match(text, /No speced contract recovered/);
  });

  it('behavior block omitted when behavior is absent', () => {
    const snap = vscodeSnap();
    const text = docsMdRenderer.render([snap]);
    assert.doesNotMatch(text, /### Behavior/);
  });

  it('shared-with block omitted when there are no siblings', () => {
    const snap = mcpSnap();
    const text = docsMdRenderer.render([snap]);
    assert.doesNotMatch(text, /### Shared with/);
  });

  it('input table renders type, optional, default, description columns', () => {
    const text = docsMdRenderer.render([cliSnap()]);
    // Spot check key cells.
    assert.match(text, /`--project`/);
    assert.match(text, /`string`/);
    assert.match(text, /`\.`/); // default value
    assert.match(text, /Project path/);
  });

  it('errors list renders error type and description', () => {
    const text = docsMdRenderer.render([cliSnap()]);
    assert.match(text, /\*\*Errors\*\*:/);
    assert.match(text, /`AnalysisError`/);
    assert.match(text, /Analysis failed/);
  });

  it('v2: top-level contract.description renders as a paragraph above the table', () => {
    const snap = {
      id: 'feat:cli:command:build',
      category: 'cli:command',
      name: 'build',
      file: 'src/cli.ts',
      contracts: [
        {
          source: 'commander',
          name: 'build',
          description: 'Compile the project',
          inputs: [{ name: 'input', type: 'string', optional: false }],
          outputs: [],
          errors: [],
        },
      ],
      sharedBehaviorWith: [],
    };
    const text = docsMdRenderer.render([snap]);
    // Description appears between the contract heading and the table.
    const headingIdx = text.indexOf('### Contract — commander');
    const descIdx = text.indexOf('Compile the project');
    const tableIdx = text.indexOf('| Input ');
    assert.ok(headingIdx >= 0 && descIdx > headingIdx && tableIdx > descIdx);
  });

  it('v2: variadic input renders with trailing ellipsis suffix', () => {
    const snap = {
      id: 'feat:cli:command:lint',
      category: 'cli:command',
      name: 'lint',
      file: 'src/cli.ts',
      contracts: [
        {
          source: 'commander',
          inputs: [{ name: 'files', type: 'string[]', optional: false, variadic: true }],
          outputs: [],
          errors: [],
        },
      ],
      sharedBehaviorWith: [],
    };
    const text = docsMdRenderer.render([snap]);
    assert.match(text, /\| `files…` \|/);
  });

  it('v2: enum values render as an "Allowed:" line below the table', () => {
    const snap = {
      id: 'feat:mcp:tool:filter',
      category: 'mcp:tool',
      name: 'filter',
      file: 'src/mcp.ts',
      contracts: [
        {
          source: 'mcp-inputSchema',
          inputs: [{ name: 'kind', type: 'string', optional: false, enum: ['cli', 'mcp', 'http'] }],
          outputs: [],
          errors: [],
        },
      ],
      sharedBehaviorWith: [],
    };
    const text = docsMdRenderer.render([snap]);
    assert.match(text, /Allowed for `kind`: \[cli, mcp, http\]/);
  });
});
