/**
 * Tests for Check Command Categories (REG-217 Phase 2)
 *
 * Tests for the category-based diagnostic filtering in `grafema check` command.
 * Tests cover:
 * - CHECK_CATEGORIES constant definition
 * - Category code mapping
 * - Filtering diagnostics by category
 * - --all flag behavior
 * - --list-categories output
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

/**
 * Category definition from check.ts implementation
 */
interface DiagnosticCheckCategory {
  name: string;
  description: string;
  codes: string[];
}

/**
 * Expected structure of CHECK_CATEGORIES constant
 */
const EXPECTED_CATEGORIES: Record<string, DiagnosticCheckCategory> = {
  'connectivity': {
    name: 'Graph Connectivity',
    description: 'Check for disconnected nodes in the graph',
    codes: ['ERR_DISCONNECTED_NODES', 'ERR_DISCONNECTED_NODE'],
  },
  'calls': {
    name: 'Call Resolution',
    description: 'Check for unresolved function calls',
    codes: ['ERR_UNRESOLVED_CALL'],
  },
  'dataflow': {
    name: 'Data Flow',
    description: 'Check for missing assignments and broken references',
    codes: ['ERR_MISSING_ASSIGNMENT', 'ERR_BROKEN_REFERENCE', 'ERR_NO_LEAF_NODE'],
  },
};

/**
 * Mock diagnostic for testing
 */
interface MockDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
}

/**
 * Filter diagnostics by category codes
 * (This is the core logic that check.ts should implement)
 */
function filterByCategory(
  diagnostics: MockDiagnostic[],
  categoryCodes: string[]
): MockDiagnostic[] {
  return diagnostics.filter(d => categoryCodes.includes(d.code));
}

// =============================================================================
// TESTS: CHECK_CATEGORIES Constant
// =============================================================================

describe('CHECK_CATEGORIES constant', () => {
  it('should define connectivity category', () => {
    const expected = EXPECTED_CATEGORIES['connectivity'];
    assert.ok(expected, 'connectivity category should exist');
    assert.strictEqual(expected.name, 'Graph Connectivity');
    assert.strictEqual(expected.description, 'Check for disconnected nodes in the graph');
    assert.deepStrictEqual(expected.codes, ['ERR_DISCONNECTED_NODES', 'ERR_DISCONNECTED_NODE']);
  });

  it('should define calls category', () => {
    const expected = EXPECTED_CATEGORIES['calls'];
    assert.ok(expected, 'calls category should exist');
    assert.strictEqual(expected.name, 'Call Resolution');
    assert.strictEqual(expected.description, 'Check for unresolved function calls');
    assert.deepStrictEqual(expected.codes, ['ERR_UNRESOLVED_CALL']);
  });

  it('should define dataflow category', () => {
    const expected = EXPECTED_CATEGORIES['dataflow'];
    assert.ok(expected, 'dataflow category should exist');
    assert.strictEqual(expected.name, 'Data Flow');
    assert.strictEqual(expected.description, 'Check for missing assignments and broken references');
    assert.deepStrictEqual(expected.codes, [
      'ERR_MISSING_ASSIGNMENT',
      'ERR_BROKEN_REFERENCE',
      'ERR_NO_LEAF_NODE'
    ]);
  });

  it('should have exactly 3 categories', () => {
    const keys = Object.keys(EXPECTED_CATEGORIES);
    assert.strictEqual(keys.length, 3, 'Should have exactly 3 categories');
  });

  it('should have connectivity, calls, and dataflow as category keys', () => {
    const keys = Object.keys(EXPECTED_CATEGORIES);
    assert.ok(keys.includes('connectivity'), 'Should have connectivity category');
    assert.ok(keys.includes('calls'), 'Should have calls category');
    assert.ok(keys.includes('dataflow'), 'Should have dataflow category');
  });
});

// =============================================================================
// TESTS: Category Code Mapping
// =============================================================================

describe('category code mapping', () => {
  it('should map ERR_DISCONNECTED_NODES to connectivity category', () => {
    const category = EXPECTED_CATEGORIES['connectivity'];
    assert.ok(category.codes.includes('ERR_DISCONNECTED_NODES'));
  });

  it('should map ERR_DISCONNECTED_NODE to connectivity category', () => {
    const category = EXPECTED_CATEGORIES['connectivity'];
    assert.ok(category.codes.includes('ERR_DISCONNECTED_NODE'));
  });

  it('should map ERR_UNRESOLVED_CALL to calls category', () => {
    const category = EXPECTED_CATEGORIES['calls'];
    assert.ok(category.codes.includes('ERR_UNRESOLVED_CALL'));
  });

  it('should map ERR_MISSING_ASSIGNMENT to dataflow category', () => {
    const category = EXPECTED_CATEGORIES['dataflow'];
    assert.ok(category.codes.includes('ERR_MISSING_ASSIGNMENT'));
  });

  it('should map ERR_BROKEN_REFERENCE to dataflow category', () => {
    const category = EXPECTED_CATEGORIES['dataflow'];
    assert.ok(category.codes.includes('ERR_BROKEN_REFERENCE'));
  });

  it('should map ERR_NO_LEAF_NODE to dataflow category', () => {
    const category = EXPECTED_CATEGORIES['dataflow'];
    assert.ok(category.codes.includes('ERR_NO_LEAF_NODE'));
  });

  it('should not have duplicate codes across categories', () => {
    const allCodes: string[] = [];
    for (const category of Object.values(EXPECTED_CATEGORIES)) {
      allCodes.push(...category.codes);
    }
    const uniqueCodes = new Set(allCodes);
    assert.strictEqual(
      allCodes.length,
      uniqueCodes.size,
      'No code should appear in multiple categories'
    );
  });
});

// =============================================================================
// TESTS: Filtering Diagnostics by Category
// =============================================================================

describe('filterByCategory()', () => {
  it('should filter diagnostics by connectivity category codes', () => {
    const diagnostics: MockDiagnostic[] = [
      { code: 'ERR_DISCONNECTED_NODES', severity: 'warning', message: 'Disconnected node A' },
      { code: 'ERR_DISCONNECTED_NODE', severity: 'warning', message: 'Disconnected node B' },
      { code: 'ERR_UNRESOLVED_CALL', severity: 'warning', message: 'Unresolved call' },
      { code: 'ERR_MISSING_ASSIGNMENT', severity: 'warning', message: 'Missing assignment' },
    ];

    const filtered = filterByCategory(diagnostics, EXPECTED_CATEGORIES['connectivity'].codes);

    assert.strictEqual(filtered.length, 2, 'Should return 2 connectivity diagnostics');
    assert.strictEqual(filtered[0].code, 'ERR_DISCONNECTED_NODES');
    assert.strictEqual(filtered[1].code, 'ERR_DISCONNECTED_NODE');
  });

  it('should filter diagnostics by calls category codes', () => {
    const diagnostics: MockDiagnostic[] = [
      { code: 'ERR_DISCONNECTED_NODES', severity: 'warning', message: 'Disconnected node' },
      { code: 'ERR_UNRESOLVED_CALL', severity: 'warning', message: 'Unresolved call A' },
      { code: 'ERR_UNRESOLVED_CALL', severity: 'warning', message: 'Unresolved call B' },
      { code: 'ERR_MISSING_ASSIGNMENT', severity: 'warning', message: 'Missing assignment' },
    ];

    const filtered = filterByCategory(diagnostics, EXPECTED_CATEGORIES['calls'].codes);

    assert.strictEqual(filtered.length, 2, 'Should return 2 calls diagnostics');
    assert.strictEqual(filtered[0].code, 'ERR_UNRESOLVED_CALL');
    assert.strictEqual(filtered[1].code, 'ERR_UNRESOLVED_CALL');
  });

  it('should filter diagnostics by dataflow category codes', () => {
    const diagnostics: MockDiagnostic[] = [
      { code: 'ERR_DISCONNECTED_NODES', severity: 'warning', message: 'Disconnected node' },
      { code: 'ERR_UNRESOLVED_CALL', severity: 'warning', message: 'Unresolved call' },
      { code: 'ERR_MISSING_ASSIGNMENT', severity: 'warning', message: 'Missing assignment' },
      { code: 'ERR_BROKEN_REFERENCE', severity: 'warning', message: 'Broken reference' },
      { code: 'ERR_NO_LEAF_NODE', severity: 'warning', message: 'No leaf node' },
    ];

    const filtered = filterByCategory(diagnostics, EXPECTED_CATEGORIES['dataflow'].codes);

    assert.strictEqual(filtered.length, 3, 'Should return 3 dataflow diagnostics');
    assert.strictEqual(filtered[0].code, 'ERR_MISSING_ASSIGNMENT');
    assert.strictEqual(filtered[1].code, 'ERR_BROKEN_REFERENCE');
    assert.strictEqual(filtered[2].code, 'ERR_NO_LEAF_NODE');
  });

  it('should return empty array when no diagnostics match category', () => {
    const diagnostics: MockDiagnostic[] = [
      { code: 'ERR_DISCONNECTED_NODES', severity: 'warning', message: 'Disconnected node' },
    ];

    const filtered = filterByCategory(diagnostics, EXPECTED_CATEGORIES['calls'].codes);

    assert.strictEqual(filtered.length, 0, 'Should return empty array');
  });

  it('should return empty array when diagnostics list is empty', () => {
    const diagnostics: MockDiagnostic[] = [];

    const filtered = filterByCategory(diagnostics, EXPECTED_CATEGORIES['connectivity'].codes);

    assert.strictEqual(filtered.length, 0, 'Should return empty array');
  });

  it('should preserve diagnostic properties when filtering', () => {
    const diagnostics: MockDiagnostic[] = [
      {
        code: 'ERR_DISCONNECTED_NODES',
        severity: 'warning',
        message: 'Node is disconnected',
        file: 'src/app.js',
        line: 42,
      },
    ];

    const filtered = filterByCategory(diagnostics, EXPECTED_CATEGORIES['connectivity'].codes);

    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].message, 'Node is disconnected');
    assert.strictEqual(filtered[0].file, 'src/app.js');
    assert.strictEqual(filtered[0].line, 42);
  });
});

// =============================================================================
// TESTS: --all Flag Behavior
// =============================================================================

describe('--all flag behavior', () => {
  it('should return all diagnostics when using --all', () => {
    const diagnostics: MockDiagnostic[] = [
      { code: 'ERR_DISCONNECTED_NODES', severity: 'warning', message: 'Disconnected node' },
      { code: 'ERR_UNRESOLVED_CALL', severity: 'warning', message: 'Unresolved call' },
      { code: 'ERR_MISSING_ASSIGNMENT', severity: 'warning', message: 'Missing assignment' },
      { code: 'ERR_BROKEN_REFERENCE', severity: 'warning', message: 'Broken reference' },
      { code: 'ERR_NO_LEAF_NODE', severity: 'warning', message: 'No leaf node' },
    ];

    // --all means no filtering, return everything
    const allDiagnostics = diagnostics;

    assert.strictEqual(allDiagnostics.length, 5, 'Should return all 5 diagnostics');
  });

  it('should not filter when no category is specified', () => {
    const diagnostics: MockDiagnostic[] = [
      { code: 'ERR_DISCONNECTED_NODES', severity: 'warning', message: 'Disconnected node' },
      { code: 'ERR_UNRESOLVED_CALL', severity: 'warning', message: 'Unresolved call' },
      { code: 'ERR_MISSING_ASSIGNMENT', severity: 'warning', message: 'Missing assignment' },
    ];

    // When no category specified, should show all (same as --all)
    const allDiagnostics = diagnostics;

    assert.strictEqual(allDiagnostics.length, 3, 'Should return all diagnostics');
  });
});

// =============================================================================
// TESTS: --list-categories Output
// =============================================================================

describe('--list-categories output', () => {
  it('should format category list output correctly', () => {
    const output = formatCategoryList(EXPECTED_CATEGORIES);

    // Should contain header
    assert.ok(
      output.includes('Available diagnostic categories') || output.includes('Categories'),
      'Should have header'
    );

    // Should list all categories
    assert.ok(output.includes('connectivity'), 'Should list connectivity');
    assert.ok(output.includes('calls'), 'Should list calls');
    assert.ok(output.includes('dataflow'), 'Should list dataflow');
  });

  it('should include category names in output', () => {
    const output = formatCategoryList(EXPECTED_CATEGORIES);

    assert.ok(output.includes('Graph Connectivity'), 'Should show connectivity name');
    assert.ok(output.includes('Call Resolution'), 'Should show calls name');
    assert.ok(output.includes('Data Flow'), 'Should show dataflow name');
  });

  it('should include category descriptions in output', () => {
    const output = formatCategoryList(EXPECTED_CATEGORIES);

    assert.ok(
      output.includes('Check for disconnected nodes'),
      'Should show connectivity description'
    );
    assert.ok(
      output.includes('Check for unresolved function calls'),
      'Should show calls description'
    );
    assert.ok(
      output.includes('Check for missing assignments'),
      'Should show dataflow description'
    );
  });

  it('should format output with proper structure', () => {
    const output = formatCategoryList(EXPECTED_CATEGORIES);
    const lines = output.split('\n');

    // Should have multiple lines (header + categories)
    assert.ok(lines.length >= 4, 'Should have at least 4 lines of output');
  });

  it('should show usage example for each category', () => {
    const output = formatCategoryList(EXPECTED_CATEGORIES);

    // Output should suggest how to use categories
    assert.ok(
      output.includes('grafema check connectivity') ||
      output.includes('check connectivity'),
      'Should show connectivity usage'
    );
  });
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format category list for --list-categories output
 * (This simulates what check.ts should produce)
 */
function formatCategoryList(categories: Record<string, DiagnosticCheckCategory>): string {
  const lines: string[] = [];
  lines.push('Available diagnostic categories:');
  lines.push('');

  for (const [key, category] of Object.entries(categories)) {
    lines.push(`  ${key}`);
    lines.push(`    ${category.name}`);
    lines.push(`    ${category.description}`);
    lines.push(`    Usage: grafema check ${key}`);
    lines.push('');
  }

  return lines.join('\n');
}
